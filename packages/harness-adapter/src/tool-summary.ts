/**
 * A redacted, allow-listed summary of what a tool call operated on.
 *
 * The runtime hands the adapter a raw JSON argument blob per call. Persisting
 * it verbatim is forbidden by the trace guardrail (arguments may carry inline
 * tokens) and dropping it entirely leaves the audit trail silent about *what*
 * a run did. This is the narrow middle: only file/command/pattern/url-ish keys
 * are read, home directories are folded to ~, known secret shapes are masked,
 * and everything is truncated. Unknown or sensitive keys never reach the
 * output, so a call whose args were just an API key yields no summary at all.
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

// Positional arguments are the one place a secret can hide from shape-based
// patterns (`login <random-token>`); no ordinary first argument is a 28+ char
// unbroken run of token-ish characters, so those get masked on command lines
// only. Paths and URLs keep their long readable segments.
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/_=-]{28,}\b/g

function redactCommand(value: string): string {
  return redact(value).replace(HIGH_ENTROPY_TOKEN, '[已隐藏]')
}

function foldHome(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replace(/[A-Za-z]:\/(?:Users|users)\/[^/]+/g, '~')
    .replace(/\/(?:Users|home)\/[^/]+/g, '~')
}

function take(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replaceAll(/\s+/g, ' ')
  }
  return undefined
}

function firstCommandLine(command: string): string {
  // Show only the leading program plus its first short argument for the list line.
  const head = command.split(/&&|;|\|\|/)[0]?.trim() ?? command.trim()
  const tokens = head.split(' ').filter(Boolean)
  if (tokens.length === 0) return ''
  const program = (tokens[0] ?? '').split(/[\\/]/).pop() ?? ''
  const next = tokens[1] ?? ''
  return next && !next.startsWith('-') && next.length <= 40 ? `${program} ${next}` : program
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
  if (command !== undefined) parts.push(redactCommand(firstCommandLine(command)))
  if (path !== undefined) parts.push(redact(foldHome(path)))
  if (pattern !== undefined) parts.push(redact(pattern.slice(0, 80)))
  if (url !== undefined) {
    const bare = url.split('?')[0] ?? url
    parts.push(redact(foldHome(bare)))
  }
  // A path/pattern is worth its fuller form in the detail line; commands stay
  // truncated to firstCommandLine so a long pipeline cannot smuggle secrets.
  const detailParts: string[] = []
  if (command !== undefined) detailParts.push(redactCommand(firstCommandLine(command)) + (command.includes('&&') || command.includes(';') ? ' …' : ''))
  if (pattern !== undefined) detailParts.push(redact(pattern.slice(0, 160)))
  if (url !== undefined) detailParts.push(redact((url.split('?')[0] ?? url).slice(0, 160)))
  if (path !== undefined) detailParts.push(redact(foldHome(path)))
  const result = summarizeParts(parts)
  if (result === undefined) return undefined
  const full = summarizeParts(detailParts)
  return {
    summary: result.summary,
    detail: full === undefined ? result.detail : full.summary,
  }
}
