/**
 * Raw tool evidence shown verbatim in the trace panel. The trace adapter
 * clips parameters and results to these bounds; `redactToolTraceText` below
 * only still guards narrative summary fields.
 */
export const TOOL_TRACE_INPUT_LIMIT = 32_000
export const TOOL_TRACE_OUTPUT_LIMIT = 32_000
const HIDDEN = '[已隐藏敏感信息]'

/** Redact before clipping, so a truncated credential can never escape detection. */
export function redactToolTraceText(value: string, maximum = TOOL_TRACE_OUTPUT_LIMIT): string {
  const scanLimit = 64_000
  const clipped = value.length > scanLimit
  let text = value.slice(0, scanLimit)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, HIDDEN)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${HIDDEN}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g, HIDDEN)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, HIDDEN)
    // Header values and named secret values, not files such as token-counter.ts.
    .replace(/((?:^|\n|["'])\s*(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*:\s*)[^\n]+/gi, `$1${HIDDEN}`)
    .replace(/((?:\b[\w.-]{0,80}(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|passphrase|credential)[\w.-]{0,80}["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, `$1${HIDDEN}`)
    .replace(/(--(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|credential)(?:\s+|=))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, `$1${HIDDEN}`)
    .replace(/((?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=))(?:(?:"[^"]*"|'[^']*')|[^\s]+)/gi, `$1${HIDDEN}`)
    .replace(/((?:^|\s)(?:-H|--header|--cookie|-b)(?:\s+|=))(?:(?:"[^"]*"|'[^']*')|[^\s]+)/gi, `$1${HIDDEN}`)
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => redactToolTraceUrl(url))
  text = text.trim()
  const limit = Number.isFinite(maximum) ? Math.max(1, Math.floor(maximum)) : TOOL_TRACE_OUTPUT_LIMIT
  return text.length <= limit && !clipped ? text : `${text.slice(0, limit - 1)}…`
}

/** URL paths may themselves contain webhook credentials; filesystem paths do not use this rule. */
export function redactToolTraceUrl(value: string): string {
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/')
    const webhook = /(?:hooks\.slack\.com|discord(?:app)?\.com)$/i.test(url.hostname)
    const path = parts.map((part, index) => {
      if ((webhook && index > 1) || /^bot\d+:/i.test(part)) return '[已隐藏]'
      // Keep human-readable documentation paths, including long filenames.
      if (/(?:token|secret|password|credential|verify|session)/i.test(parts[index - 1] ?? '')) return '[已隐藏]'
      if (/^(?:sk-|gh[pousr]_|xox[baprs]-)/i.test(part)) return '[已隐藏]'
      if (part.length >= 20 && /[A-Z]/.test(part) && /\d/.test(part)) return '[已隐藏]'
      return part
    }).join('/')
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return '[无法解析的地址]'
  }
}

/** Only file contents are suppressed. The owner can still see the filename. */
export function isSensitiveToolPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  return /(?:^|\/|:)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|(?:credentials?|secrets?|private[_-]?key)(?:\.(?:json|ya?ml|toml|ini|conf|txt|pem|key))?|gh_hosts_token\.yml)$/.test(normalized)
    || /(?:^|\/)(?:\.ssh|\.aws|\.gnupg)(?:\/|$)/.test(normalized)
}
