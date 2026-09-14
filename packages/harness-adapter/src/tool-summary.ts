/**
 * Bounded tool-call parameter text for the owner's trace. Credential values
 * become stable variables before the detail is clipped or persisted.
 */
import { clipToolEvidence } from './evidence-bounds.js'
import { CredentialRedactor } from '@dsh-cyber/contracts'

export interface ToolCallSummary {
  /** One short display line for the target row (the command, or the compact record). */
  summary: string
  /** The bounded, credential-safe parameter text for the expandable view. */
  detail: string
  /** Whether the expandable detail contains a bounded head/tail view. */
  truncated?: true
  /** Whether a credential value or credential-shaped value was replaced. */
  redacted?: true
}

const COMMAND_KEYS = ['command', 'cmd', 'script'] as const
const MAX_SUMMARY = 120

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
 * exact credential-safe argument payload (the runtime's own JSON for string
 * payloads, a pretty-printed record otherwise).
 */
export function summarizeToolCall(
  rawArguments: unknown,
  redactText: (value: string) => string = defaultRedactor.text.bind(defaultRedactor),
): ToolCallSummary | undefined {
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
  const redactedDetail = redactText(detail)
  const redactedSummary = redactText(summarySource)
  const bounded = clipToolEvidence(redactedDetail)
  return {
    summary: clip(redactedSummary, MAX_SUMMARY),
    detail: bounded.value,
    ...(bounded.truncated ? { truncated: true } : {}),
    ...(redactedDetail !== detail || redactedSummary !== summarySource ? { redacted: true } : {}),
  }
}

const defaultRedactor = new CredentialRedactor()
