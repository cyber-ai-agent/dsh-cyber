/**
 * Raw tool-call parameter text for the owner's trace.
 *
 * The trace panel shows the tool's actual parameters and result verbatim in
 * an expandable box: no secret masking, no argument allow-listing, no home
 * folding. Values are only clipped to a bounded length so a single call
 * cannot bloat the trace or the persisted message metadata.
 */
export interface ToolCallSummary {
  /** One short display line for the target row (the command, or the compact record). */
  summary: string
  /** The full raw parameter text for the expandable view. */
  detail: string
}

const COMMAND_KEYS = ['command', 'cmd', 'script'] as const
const MAX_SUMMARY = 120
const MAX_DETAIL = 32_000

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

function take(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/)[0] ?? value
  return line.trim()
}

/**
 * Display the direct command parameters of a tool call.
 *
 * Command-shaped records show the command string; anything else shows the
 * exact argument payload (the runtime's own JSON for string payloads, a
 * pretty-printed record otherwise). Nothing is redacted.
 */
export function summarizeToolCall(rawArguments: unknown): ToolCallSummary | undefined {
  if (rawArguments === undefined) return undefined
  const record = argsRecord(rawArguments)
  const detail = typeof rawArguments === 'string'
    ? rawArguments
    : JSON.stringify(rawArguments, null, 2)
  const trimmed = detail.trim()
  if (!trimmed) return undefined
  const summarySource = record !== undefined
    ? (take(record, COMMAND_KEYS) ?? (typeof rawArguments === 'string' ? trimmed : JSON.stringify(record)))
    : firstLine(trimmed)
  return {
    summary: clip(summarySource, MAX_SUMMARY),
    detail: clip(detail, MAX_DETAIL),
  }
}
