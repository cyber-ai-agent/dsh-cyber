import type { JsonObject } from '@dsh-cyber/contracts'

interface ToolSubject { name: string }

/**
 * One instance per AgentRun. Results are only claimed by the session and
 * call id that started them; that identity guard is not a hiding mechanism.
 */
export class ToolTraceSubjects {
  readonly #subjects = new Map<string, ToolSubject>()

  start(sessionId: string, callId: string, name: string): void {
    this.#subjects.set(JSON.stringify([sessionId, callId]), { name: name.slice(0, 160) })
    // Overload loses the oldest association, never the primary turn.
    while (this.#subjects.size > 256) this.#subjects.delete(this.#subjects.keys().next().value!)
  }

  complete(sessionId: string, callId: string): ToolSubject | undefined {
    const key = JSON.stringify([sessionId, callId])
    const subject = this.#subjects.get(key)
    this.#subjects.delete(key)
    return subject
  }
}

/** Bounded raw result text: the full call output, clipped but never redacted. */
const SCAN_LIMIT = 32_000

/**
 * Extract the actual text a tool call returned.
 *
 * The trace panel shows this verbatim in the expandable "查看结果" box, so no
 * secret masking and no per-tool allow-listing happens here. Only a call that
 * was never started in this session has no text claimed for it.
 */
export function summarizeToolResult(data: Record<string, unknown>, subject?: ToolSubject): JsonObject {
  const result: JsonObject = {}
  const message = object(data.message)
  const output = object(data.result)
  const meta = object(data.meta)
  const exitCode = data.exitCode ?? output?.exitCode ?? meta?.exitCode
  if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) result.toolExitCode = exitCode
  if (subject === undefined) return result
  const texts: string[] = []
  let scanned = 0
  let truncated = false
  const surface = Array.isArray(message?.content) ? message.content : []
  const callId = object(message?.source)?.callId
  // rc.1 represents tool output as user-message -> tool-result -> text.
  // Unwrap this documented layer only; never descend into images or arbitrary JSON.
  const blocks = surface.slice(0, 64).flatMap((value) => {
    const block = object(value)
    if (block?.type === 'tool-result') {
      return block.toolCallId === callId && Array.isArray(block.content) ? block.content.slice(0, 64) : []
    }
    return block?.type === 'text' ? [block] : []
  })
  for (const value of blocks.slice(0, 64)) {
    const block = object(value)
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const remaining = SCAN_LIMIT - scanned
    if (remaining <= 0) { truncated = true; break }
    const text = block.text.slice(0, remaining)
    texts.push(text)
    scanned += text.length
    if (block.text.length > remaining) truncated = true
  }
  // A small number of providers report a single plain output rather than blocks.
  if (texts.length === 0) {
    for (const key of ['stdout', 'stderr', 'output', 'text'] as const) {
      const value = output?.[key] ?? data[key]
      if (typeof value !== 'string' || !value.trim()) continue
      const remaining = SCAN_LIMIT - scanned
      if (remaining <= 0) { truncated = true; break }
      texts.push(`${key}:\n${value.slice(0, remaining)}`)
      scanned += Math.min(value.length, remaining)
      if (value.length > remaining) truncated = true
    }
  }
  // Native write/edit presentation metadata is host-observed, unlike
  // model-proposed old_string/new_string arguments. Show the actual hunks.
  if (/^(?:write|edit)$/.test(subject.name) && Array.isArray(meta?.diffs)) {
    if (meta.diffs.length > 4) truncated = true
    for (const raw of meta.diffs.slice(0, 4)) {
      const diff = object(raw)
      if (typeof diff?.path !== 'string' || typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') continue
      const remaining = Math.max(0, SCAN_LIMIT - scanned)
      const half = Math.min(4_000, Math.floor(remaining / 2))
      if (half === 0) { truncated = true; break }
      const oldText = diff.oldText.slice(0, half)
      const newText = diff.newText.slice(0, half)
      if (diff.oldText.length > half || diff.newText.length > half) truncated = true
      texts.push(`[实际变更片段] ${diff.path}\n--- 修改前\n${oldText}\n+++ 修改后\n${newText}`)
      scanned += oldText.length + newText.length + 400
    }
  }
  const original = texts.join('\n').trim()
  if (!original) return result
  result.toolOutput = original
  if (truncated) result.toolOutputTruncated = true
  return result
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
