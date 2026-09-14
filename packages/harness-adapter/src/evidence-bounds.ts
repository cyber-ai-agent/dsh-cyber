/**
 * Shared bounds for owner-facing runtime evidence.
 *
 * Tool arguments and results remain useful after clipping because the head
 * carries the command or output header and the tail carries the final status,
 * exit marker, or last diagnostic lines. The full model-facing tool result is
 * handled by DSH's session compaction path.
 */
export const TOOL_EVIDENCE_MAX_CHARS = 4_096
export const TOOL_EVIDENCE_HEAD_CHARS = 3_072
export const TOOL_EVIDENCE_TAIL_CHARS = 768
export const TOOL_EVIDENCE_OMISSION = '\n\n[… 中间内容已省略 …]\n\n'

export interface BoundedEvidence {
  value: string
  truncated: boolean
}

/** Keep a bounded head and tail without splitting a UTF-16 surrogate pair. */
export function clipToolEvidence(
  value: string,
  maximum = TOOL_EVIDENCE_MAX_CHARS,
): BoundedEvidence {
  if (value.length <= maximum) return { value, truncated: false }
  const marker = TOOL_EVIDENCE_OMISSION
  const available = Math.max(0, maximum - marker.length)
  const tail = Math.min(TOOL_EVIDENCE_TAIL_CHARS, Math.floor(available * 0.25))
  const head = Math.max(0, available - tail)
  const headEnd = safeHeadEnd(value, head)
  const tailStart = safeTailStart(value, value.length - tail)
  return {
    value: `${value.slice(0, headEnd)}${marker}${value.slice(tailStart)}`,
    truncated: true,
  }
}

/** Accumulate arbitrary text while retaining only a bounded diagnostic view. */
export class BoundedEvidenceCollector {
  readonly #maximum: number
  #full = ''
  #head = ''
  #tail = ''
  #truncated = false

  constructor(maximum = TOOL_EVIDENCE_MAX_CHARS) {
    this.#maximum = Math.max(1, Math.trunc(maximum))
  }

  add(value: string): void {
    if (!value) return
    if (!this.#truncated && this.#full.length + value.length <= this.#maximum) {
      this.#full += value
      return
    }
    if (!this.#truncated) {
      this.#truncated = true
      this.#head = this.#full.slice(0, safeHeadEnd(this.#full, TOOL_EVIDENCE_HEAD_CHARS))
      this.#tail = this.#full.slice(safeTailStart(this.#full, this.#full.length - TOOL_EVIDENCE_TAIL_CHARS))
    }
    const headRoom = Math.max(0, TOOL_EVIDENCE_HEAD_CHARS - this.#head.length)
    if (headRoom > 0) this.#head += value.slice(0, safeHeadEnd(value, headRoom))
    if (value.length >= TOOL_EVIDENCE_TAIL_CHARS) {
      this.#tail = value.slice(safeTailStart(value, value.length - TOOL_EVIDENCE_TAIL_CHARS))
    } else {
      const tailSource = `${this.#tail}${value}`
      const tailStart = Math.max(0, tailSource.length - TOOL_EVIDENCE_TAIL_CHARS)
      this.#tail = tailSource.slice(safeTailStart(tailSource, tailStart))
    }
  }

  finish(): BoundedEvidence {
    if (!this.#truncated) return { value: this.#full, truncated: false }
    return {
      value: `${this.#head}${TOOL_EVIDENCE_OMISSION}${this.#tail}`.trim(),
      truncated: true,
    }
  }
}

function safeHeadEnd(value: string, requested: number): number {
  const end = Math.max(0, Math.min(value.length, Math.trunc(requested)))
  return end > 0 && end < value.length && isLowSurrogate(value.charCodeAt(end))
    ? end - 1
    : end
}

function safeTailStart(value: string, requested: number): number {
  const start = Math.max(0, Math.min(value.length, Math.trunc(requested)))
  return start < value.length && start > 0 && isLowSurrogate(value.charCodeAt(start))
    ? start + 1
    : start
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
