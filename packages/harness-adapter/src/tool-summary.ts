/**
 * A redacted, allow-listed summary of what a tool call operated on.
 *
 * The runtime hands the adapter a raw JSON argument blob per call. Persisting
 * it verbatim is forbidden by the trace guardrail (arguments may carry inline
 * tokens) and dropping it entirely leaves the audit trail silent about *what*
 * a run did. This is the narrow middle, and it is deny-by-default: only
 * file/command/pattern/url-ish keys are read; a command keeps its program and
 * only a lowercase subcommand or a path-shaped argument; path and URL segments
 * must positively read as human-authored (short, lowercase, no credential
 * words, no id-shaped digit or mixed-case runs) or they are masked per
 * segment; query strings are stripped; home directories fold to ~; known
 * secret shapes are masked; everything is truncated. A call whose arguments
 * hold nothing safe yields no summary at all.
 */
export interface ToolCallSummary {
  /** One short line for the list: program name + first argument, or the file. */
  summary: string
  /** The fuller redacted target for the expanded view. */
  detail: string
}

const COMMAND_KEYS = ['command', 'cmd', 'script'] as const
const PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'filename', 'directory', 'dir', 'target_path', 'target'] as const
const PATTERN_KEYS = ['pattern', 'glob', 'query', 'search', 'regex'] as const
const URL_KEYS = ['url', 'uri', 'endpoint'] as const
const MAX_SUMMARY = 120
const MAX_DETAIL = 480

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\b(?:api[-_ ]?key|authorization|password|passwd|token|secret|credential)s?\s*[:=]\s*[^\s,;'"]+/gi,
  /(["']?[A-Za-z0-9_-]*(?:token|secret|password|api_key|apikey|access_key|private_key)[A-Za-z0-9_-]*["']?\s*[:=]\s*)[^\s,;'"]+/gi,
]

function redact(value: string): string {
  let out = value
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[已隐藏]')
  return out
}

function foldHome(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/[A-Za-z]:\/(?:Users|users)\/[^/]+/g, '~')
    .replace(/\/(?:Users|home)\/[^/]+/g, '~')
}

// A path/URL segment is kept only when it positively reads as human-authored:
// short and lowercase, or a small extension-suffixed file name. Credential
// words, long mixed-case runs, and id-shaped digit mixes (webhook and bot-API
// secrets live exactly there) are replaced per segment.
const CREDENTIALISH = /(token|secret|passw|credential|api[_-]?key|access[_-]?key|private[_-]?key|\bauth\b|\bpwd\b|session|\bsid\b|otp|verify|key)/i
function safeSegment(segment: string): boolean {
  if (segment.length === 0) return true
  if (CREDENTIALISH.test(segment)) return false
  if (segment.length > 24) return false
  if (/[A-Z]/.test(segment) && /\d/.test(segment)) return false
  if (segment.length >= 12 && /\d/.test(segment)) return false
  if (segment.length >= 16 && !/^[a-z0-9][a-z0-9.-]*$/.test(segment)) return false
  if (segment.length >= 12 && segment.includes('_')) return false
  return true
}

function redactPathish(value: string): string {
  const segments = value.split('/')
  const kept = segments.map((segment) => (safeSegment(segment) ? segment : '[已隐藏]'))
  return kept.join('/')
}

function redactUrl(value: string): string {
  const bare = value.split(/[?#]/)[0] ?? value
  let url: URL
  try {
    url = new URL(bare)
  } catch {
    return '[无法解析的地址]'
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  const kept = segments.slice(0, 4).map((segment) => (safeSegment(segment) ? segment : '[已隐藏]'))
  const suffix = segments.length > 4 ? '/…' : ''
  return `${url.protocol}//${url.host}/${kept.join('/')}${suffix}`
}

function take(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replaceAll(/\s+/g, ' ')
  }
  return undefined
}

function firstCommandLine(command: string): string {
  // Program by default. The first argument survives only when it positively
  // reads as a subcommand (pure lowercase, git/npm/docker style) or as a path
  // (then segment-redacted). Anything else — short passwords, opaque ids —
  // becomes an explicit marker, so unrecognized secrets cannot ride along.
  const head = command.split(/&&|;|\|\|/)[0]?.trim() ?? command.trim()
  const tokens = head.split(' ').filter(Boolean)
  if (tokens.length === 0) return ''
  const program = (tokens[0] ?? '').split(/[\\/]/).pop() ?? ''
  const next = tokens[1] ?? ''
  if (next.length === 0 || next.startsWith('-')) return redact(program)
  if (/^[a-z][a-z-]{0,15}$/.test(next)) return `${redact(program)} ${next}`
  if (/[/\\~]|\.[A-Za-z0-9]{1,8}$|^[A-Za-z]:/.test(next)) return `${redact(program)} ${redactPathish(foldHome(next))}`
  return `${redact(program)} [参数已隐藏]`
}

function summarizeParts(parts: string[]): { summary: string; detail: string } | undefined {
  const unique = [...new Set(parts.filter((part) => part.length > 0))]
  if (unique.length === 0) return undefined
  return {
    summary: unique.join(' · ').slice(0, MAX_SUMMARY),
    detail: unique.join(' · ').slice(0, MAX_DETAIL),
  }
}

function argsRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function summarizeToolCall(rawArguments: unknown): ToolCallSummary | undefined {
  const record = argsRecord(rawArguments)
  if (record === undefined) return undefined
  const command = take(record, COMMAND_KEYS)
  const path = take(record, PATH_KEYS)
  const pattern = take(record, PATTERN_KEYS)
  const url = take(record, URL_KEYS)
  const parts: string[] = []
  if (command !== undefined) parts.push(firstCommandLine(command))
  if (path !== undefined) parts.push(redact(redactPathish(foldHome(path))))
  if (pattern !== undefined) parts.push(redact(pattern.slice(0, 80)))
  if (url !== undefined) parts.push(redactUrl(url))
  // The detail line keeps fuller pattern text; commands stay on
  // firstCommandLine so a pipeline tail cannot smuggle anything through.
  const detailParts: string[] = []
  if (command !== undefined) detailParts.push(firstCommandLine(command) + (command.includes('&&') || command.includes(';') ? ' …' : ''))
  if (pattern !== undefined) detailParts.push(redact(pattern.slice(0, 160)))
  if (url !== undefined) detailParts.push(redactUrl(url))
  if (path !== undefined) detailParts.push(redact(redactPathish(foldHome(path))))
  const result = summarizeParts(parts)
  if (result === undefined) return undefined
  const full = summarizeParts(detailParts)
  return {
    summary: result.summary,
    detail: full === undefined ? result.detail : full.detail,
  }
}
