import { isSensitiveToolPath, redactToolTraceText, TOOL_TRACE_INPUT_LIMIT } from '@dsh-cyber/contracts'

/** Structured targets for the owner's trace; credential values are never retained. */
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
const MAX_DETAIL = TOOL_TRACE_INPUT_LIMIT

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
  // Long source filenames, UUID artifact manifests and words such as session
  // or keyboard are legitimate filesystem identifiers. Redact values only.
  return redactToolTraceText(value, MAX_DETAIL)
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
    if (typeof value === 'string' && value.trim()) return value.slice(0, 64_000).trim()
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
    summary: redactToolTraceText(unique.join(' · '), MAX_SUMMARY),
    detail: redactToolTraceText(unique.join(' · '), MAX_DETAIL),
  }
}

function argsRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1_000_000) return undefined
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
  if (command !== undefined) detailParts.push(commandDetail(command))
  if (pattern !== undefined) detailParts.push(redact(pattern.slice(0, 160)))
  if (url !== undefined) detailParts.push(redactUrl(url))
  if (path !== undefined) detailParts.push(redact(redactPathish(foldHome(path))))
  for (const key of ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'line_start', 'line_end']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) detailParts.push(`${key}=${value}`)
  }
  if (typeof record.characterId === 'string') {
    parts.push(redactToolTraceText(record.characterId, 160))
    detailParts.push(redactToolTraceText(record.characterId, 160))
  }
  if (parts.length === 0 && detailParts.length > 0) parts.push(...detailParts)
  const result = summarizeParts(parts)
  if (result === undefined) return undefined
  const full = summarizeParts(detailParts)
  return {
    summary: result.summary,
    detail: full === undefined ? result.detail : full.detail,
  }
}


function commandDetail(command: string): string {
  // Show real flags for ordinary development commands. Unknown programs and
  // inline scripts remain summarized; do not pretend to parse a full shell.
  const commands = command.split(/&&|\|\||[;\n]/)
  const known = /^(?:git|pnpm|npm|yarn|bun|node|python3?|pytest|vitest|tsc|cargo|go|make|cmake|rg|grep|find|ls|pwd|cat|head|tail|wc|docker|curl)(?:\s|$)/
  if (commands.every((part) => known.test(part.trim())) && !/[|`]|\$\(|(?:^|\s)(?:-e|-c|--eval|--command)(?:\s|=)/.test(command)) {
    return redactToolTraceText(command, MAX_DETAIL)
  }
  return firstCommandLine(command) + (commands.length > 1 ? ' …' : '')
}

export function toolCallAllowsOutput(rawArguments: unknown, toolName: string): boolean {
  const args = argsRecord(rawArguments)
  if (args === undefined) return false
  const path = take(args, PATH_KEYS)
  if (path !== undefined && isSensitiveToolPath(path)) return false
  const command = take(args, COMMAND_KEYS)
  if (command !== undefined) {
    // Normal development commands may expose bounded, value-redacted output.
    // Environment dumps, credential containers and inline shell programs do not.
    if (/[|`]|\$\(|(?:^|\s)(?:-e|-c|--eval|--command)(?:\s|=)/.test(command)) return false
    if (command.split(/[\s"']+/).some(isSensitiveToolPath)) return false
    const parts = command.split(/&&|\|\||[;\n]/).map((part) => part.trim())
    return parts.every((part) => /^(?:git (?:status|diff|log|show|ls-files|rev-parse)|(?:pnpm|npm|yarn|bun) (?:test|build|typecheck|run (?:test|build|typecheck)|exec (?:vitest|tsc|playwright))|(?:vitest|tsc|pytest|ls|pwd|rg|grep|head|tail|cat|wc|find)|cargo (?:test|build|check)|go (?:test|build|vet))(?:\s|$)/.test(part))
  }
  return /^(?:read|read_file|readfile|write|write_file|edit|str_replace_editor|apply_patch|grep|glob|search|find|world_directory_(?:list|search|get))$/i.test(toolName)
}
