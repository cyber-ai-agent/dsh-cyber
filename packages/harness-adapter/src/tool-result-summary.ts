import { createHash } from 'node:crypto'
import type { JsonObject } from '@dsh-cyber/contracts'
import { BoundedEvidenceCollector } from './evidence-bounds.js'

interface ToolSubject { name: string }

/**
 * One instance per AgentRun. Results are only claimed by the session and
 * call id that started them; that identity guard is not a hiding mechanism.
 */
export class ToolTraceSubjects {
  readonly #subjects = new Map<string, ToolSubject>()
  readonly #outputReferences = new Map<string, string>()

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

  /** Replace repeated output bodies with a small reference to the first call. */
  deduplicateToolResult(callId: string, metadata: JsonObject): JsonObject {
    const hash = metadata.toolOutputHash
    if (typeof hash !== 'string' || hash.length === 0) return metadata
    const previousCallId = this.#outputReferences.get(hash)
    if (previousCallId !== undefined && previousCallId !== callId) {
      delete metadata.toolOutput
      delete metadata.toolOutputTruncated
      metadata.toolOutputDuplicateOf = previousCallId
      return metadata
    }
    this.#outputReferences.set(hash, callId)
    while (this.#outputReferences.size > 512) this.#outputReferences.delete(this.#outputReferences.keys().next().value!)
    return metadata
  }
}

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
  const collector = new BoundedEvidenceCollector()
  const hash = createHash('sha256')
  let hasOutput = false
  let truncated = false
  const surface = Array.isArray(message?.content) ? message.content : []
  const callId = object(message?.source)?.callId
  if (surface.length > 64) truncated = true
  // 0.1.5-rc.2 represents tool output as user-message -> tool-result -> text.
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
    appendEvidence(collector, hash, block.text, 'text', hasOutput)
    hasOutput = true
  }
  // A small number of providers report a single plain output rather than blocks.
  if (!hasOutput) {
    for (const key of ['stdout', 'stderr', 'output', 'text'] as const) {
      const value = output?.[key] ?? data[key]
      if (typeof value !== 'string' || !value.trim()) continue
      appendEvidence(collector, hash, `${key}:\n${value}`, key, hasOutput)
      hasOutput = true
    }
  }
  // Native write/edit presentation metadata is host-observed, unlike
  // model-proposed old_string/new_string arguments. Show the actual hunks.
  if (/^(?:write|edit)$/.test(subject.name) && Array.isArray(meta?.diffs)) {
    if (meta.diffs.length > 4) truncated = true
    for (const raw of meta.diffs.slice(0, 4)) {
      const diff = object(raw)
      if (typeof diff?.path !== 'string' || typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') continue
      appendEvidence(
        collector,
        hash,
        `[实际变更片段] ${diff.path}\n--- 修改前\n${diff.oldText}\n+++ 修改后\n${diff.newText}`,
        'diff',
        hasOutput,
      )
      hasOutput = true
    }
  }
  const bounded = collector.finish()
  if (!hasOutput || !bounded.value) return result
  result.toolOutput = bounded.value
  result.toolOutputHash = hash.digest('hex').slice(0, 16)
  if (truncated || bounded.truncated) result.toolOutputTruncated = true
  return result
}

function appendEvidence(
  collector: BoundedEvidenceCollector,
  hash: ReturnType<typeof createHash>,
  value: string,
  kind: string,
  hasOutput: boolean,
): void {
  if (hasOutput) {
    collector.add('\n')
    hash.update('\n')
  }
  hash.update(`${kind}\u0000${value}\u0000`)
  collector.add(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
