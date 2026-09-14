import { describe, expect, it } from 'vitest'
import {
  BoundedEvidenceCollector,
  clipToolEvidence,
  TOOL_EVIDENCE_MAX_CHARS,
  TOOL_EVIDENCE_OMISSION,
} from '../src/evidence-bounds.js'

describe('bounded runtime evidence', () => {
  it('keeps a readable head and tail within the storage budget', () => {
    const value = `命令开始\n${'中间输出\n'.repeat(4_000)}命令结束`
    const clipped = clipToolEvidence(value)

    expect(clipped.truncated).toBe(true)
    expect(clipped.value.length).toBeLessThanOrEqual(TOOL_EVIDENCE_MAX_CHARS)
    expect(clipped.value).toContain('命令开始')
    expect(clipped.value).toContain('命令结束')
    expect(clipped.value).toContain(TOOL_EVIDENCE_OMISSION.trim())
  })

  it('preserves surrogate-pair boundaries while clipping', () => {
    const value = `${'a'.repeat(4_000)}🧪${'b'.repeat(4_000)}🧪`
    const clipped = clipToolEvidence(value)

    expect(clipped.value).not.toContain('\uFFFD')
    expect(clipped.value.length).toBeLessThanOrEqual(TOOL_EVIDENCE_MAX_CHARS)
  })

  it('retains the final tail when several output blocks exceed the budget', () => {
    const collector = new BoundedEvidenceCollector()
    collector.add(`头部${'x'.repeat(4_000)}`)
    collector.add('\n')
    collector.add(`${'y'.repeat(4_000)}尾部`)
    const result = collector.finish()

    expect(result.truncated).toBe(true)
    expect(result.value).toContain('头部')
    expect(result.value).toContain('尾部')
    expect(result.value.length).toBeLessThanOrEqual(TOOL_EVIDENCE_MAX_CHARS)
  })
})
