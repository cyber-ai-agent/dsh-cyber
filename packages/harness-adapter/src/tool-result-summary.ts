import {
  redactToolTraceText,
  isSensitiveToolPath,
  TOOL_TRACE_OUTPUT_LIMIT,
  type JsonObject,
} from '@dsh-cyber/contracts'
import { toolCallAllowsOutput } from './tool-summary.js'

interface ToolSubject { name: string; allowOutput: boolean }

/** One instance per AgentRun. Never retain raw arguments, file bodies or credentials. */
export class ToolTraceSubjects {
  readonly #subjects = new Map<string, ToolSubject>()

  start(sessionId: string, callId: string, name: string, args: unknown): void {
    this.#subjects.set(JSON.stringify([sessionId, callId]), {
      name: redactToolTraceText(name, 160),
      allowOutput: toolCallAllowsOutput(args, name),
    })
    // Overload loses optional detail, never isolation or the primary turn.
    while (this.#subjects.size > 256) this.#subjects.delete(this.#subjects.keys().next().value!)
  }

  complete(sessionId: string, callId: string): ToolSubject | undefined {
    const key = JSON.stringify([sessionId, callId])
    const subject = this.#subjects.get(key)
    this.#subjects.delete(key)
    return subject
  }
}

/** Only documented text blocks and explicit scalar results; never stringify arbitrary data. */
export function summarizeToolResult(data: Record<string, unknown>, subject?: ToolSubject): JsonObject {
  const result: JsonObject = {}
  const message = object(data.message)
  const output = object(data.result)
  const exitCode = data.exitCode ?? output?.exitCode ?? object(data.meta)?.exitCode
  if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) result.toolExitCode = exitCode
  if (subject === undefined) return result
  const meta = object(data.meta)
  if (!subject.allowOutput || (typeof meta?.path === 'string' && isSensitiveToolPath(meta.path))) {
    result.toolOutput = '未记录此调用的文本结果（凭据文件、任意脚本或尚未适配的工具）。'
    result.toolOutputRedacted = true
    return result
  }
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
  const texts: string[] = []
  let scanned = 0
  let truncated = surface.length > 64 || blocks.length > 64
  for (const value of blocks.slice(0, 64)) {
    const block = object(value)
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const remaining = 32_000 - scanned
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
      const remaining = 32_000 - scanned
      if (remaining <= 0) { truncated = true; break }
      texts.push(`${key}:\n${value.slice(0, remaining)}`)
      scanned += Math.min(value.length, remaining)
      if (value.length > remaining) truncated = true
    }
  }
  // Native read/write/edit presentation metadata is host-observed, unlike
  // model-proposed old_string/new_string arguments. Show only actual hunks.
  if (/^(?:write|edit)$/.test(subject.name) && Array.isArray(meta?.diffs)) {
    if (meta.diffs.length > 4) truncated = true
    for (const raw of meta.diffs.slice(0, 4)) {
      const diff = object(raw)
      if (typeof diff?.path !== 'string' || typeof diff.oldText !== 'string' || typeof diff.newText !== 'string') continue
      if (isSensitiveToolPath(diff.path)) {
        texts.push('[凭据文件的变更内容已隐藏敏感信息]')
        result.toolOutputRedacted = true
        continue
      }
      const remaining = Math.max(0, 32_000 - scanned)
      const half = Math.min(4_000, Math.floor(remaining / 2))
      if (half === 0) { truncated = true; break }
      const oldText = diff.oldText.slice(0, half)
      const newText = diff.newText.slice(0, half)
      if (diff.oldText.length > half || diff.newText.length > half) truncated = true
      texts.push(`[实际变更片段] ${redactToolTraceText(diff.path, 300)}\n--- 修改前\n${oldText}\n+++ 修改后\n${newText}`)
      scanned += oldText.length + newText.length + 400
    }
  }
  const original = texts.join('\n').trim()
  if (!original) return result
  const sanitized = redactToolTraceText(original)
  if (!sanitized) return result
  result.toolOutput = sanitized
  if (truncated || original.length > TOOL_TRACE_OUTPUT_LIMIT) result.toolOutputTruncated = true
  if (/\[已隐藏(?:敏感信息)?\]/.test(sanitized)) result.toolOutputRedacted = true
  return result
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
