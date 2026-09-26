import { describe, expect, it } from 'vitest'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { normalizeHarnessNotification, normalizeHarnessTraceNotification } from '../src/adapter.js'
import { ToolTraceSubjects } from '../src/tool-result-summary.js'
import { summarizeToolCall } from '../src/tool-summary.js'
import { TOOL_EVIDENCE_MAX_CHARS, TOOL_EVIDENCE_OMISSION } from '../src/evidence-bounds.js'

function event(type: string, data: object, sessionId = 's'): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data, seq: 1, time: 1 } } } as HarnessNotification
}
function result(text: string, callId = 'c', sessionId = 's') {
  return event('tool/result', { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text }], isError: false } }, sessionId)
}
function start(subjects: ToolTraceSubjects, args: object, name = 'read', callId = 'c', sessionId = 's') {
  return normalizeHarnessTraceNotification(event('tool/call', { name, callId, arguments: JSON.stringify(args) }, sessionId), subjects)
}

describe('sanitized tool evidence from current Harness event shapes', () => {
  it('recognizes V4 failed tool messages without an outer error and rejects a conflicting call id', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { file_path: 'src/index.ts' })
    const failed = event('tool/result', { message: { role: 'tool', toolCallId: 'c', source: { kind: 'tool', callId: 'c' }, content: [{ type: 'text', text: 'read failed' }], isError: true } })
    const [done] = normalizeHarnessTraceNotification(failed, subjects)
    expect(done?.failed).toBe(true)
    expect(done?.metadata.toolOutput).toContain('read failed')

    start(subjects, { file_path: 'src/index.ts' })
    const mismatched = event('tool/result', { message: { role: 'tool', toolCallId: 'other', source: { kind: 'tool', callId: 'c' }, content: [{ type: 'text', text: 'wrong call' }] } })
    expect(normalizeHarnessTraceNotification(mismatched, subjects)[0]?.metadata.toolOutput).toBeUndefined()
  })
  it('still reads V3 tool-result wrappers during migration diagnostics', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { file_path: 'src/legacy.ts' })
    const legacy = event('tool/result', { message: { source: { callId: 'c' }, content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: 'legacy result' }] }] } })
    expect(normalizeHarnessTraceNotification(legacy, subjects)[0]?.metadata.toolOutput).toBe('legacy result')
  })
  it('keeps long code filenames and raw read ranges', () => {
    const summary = summarizeToolCall({ file_path: 'packages/server/src/services/character-profile-runtime.ts', offset: 10, limit: 25 })!
    expect(summary.detail).toContain('character-profile-runtime.ts')
    expect(summary.detail).toContain('"offset": 10')
    expect(summary.detail).toContain('"limit": 25')
  })
  it('keeps actual nested text results and the raw input bodies', () => {
    const subjects = new ToolTraceSubjects()
    const [call] = start(subjects, { file_path: 'src/token-counter.ts', content: 'RAW-INPUT-BODY' })
    // Ordinary source content remains readable in the bounded trace view.
    expect(JSON.stringify(call)).toContain('RAW-INPUT-BODY')
    const [done] = normalizeHarnessTraceNotification(result('1 export const count = 1\n2 // next'), subjects)
    expect(done?.metadata.toolOutput).toContain('export const count')
    expect(done?.toolName).toBe('read')
  })
  it('does not let another session or run claim a result', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { file_path: 'src/index.ts' })
    expect(normalizeHarnessTraceNotification(result('PRIVATE', 'c', 'other'), subjects)[0]?.metadata.toolOutput).toBeUndefined()
    expect(normalizeHarnessTraceNotification(result('PRIVATE'), new ToolTraceSubjects())[0]?.metadata.toolOutput).toBeUndefined()
    expect(normalizeHarnessTraceNotification(result('own'), subjects)[0]?.metadata.toolOutput).toBe('own')
    expect(normalizeHarnessTraceNotification(result('late duplicate'), subjects)[0]?.metadata.toolOutput).toBeUndefined()
  })
  it('keeps unlabeled output when no credential shape is present', () => {
    const subjects = new ToolTraceSubjects()
    expect(start(subjects, { file_path: '.env' })[0]?.metadata.toolSummary).toBe('{"file_path":".env"}')
    const value = normalizeHarnessTraceNotification(result('UNLABELED-PRIVATE-VALUE'), subjects)[0]
    expect(value?.metadata.toolOutput).toBe('UNLABELED-PRIVATE-VALUE')
    expect(value?.metadata.toolOutputRedacted).toBeUndefined()
  })
  it('clips large results with an explicit truncation and redaction flag', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { file_path: 'src/index.ts' })
    const [done] = normalizeHarnessTraceNotification(result('access_token="opaque private value"\n' + 'x'.repeat(40_000)), subjects)
    expect(done?.metadata.toolOutput).not.toContain('opaque private value')
    expect((done?.metadata.toolOutput as string).length).toBeLessThanOrEqual(32_000)
    expect(done?.metadata.toolOutputTruncated).toBe(true)
    expect(done?.metadata.toolOutputRedacted).toBe(true)
  })
  it('keeps large result evidence to a head/tail view', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { command: 'rg repeated-output' }, 'bash', 'large')
    const body = `RESULT-HEAD\n${'middle\n'.repeat(4_000)}RESULT-TAIL`
    const [done] = normalizeHarnessTraceNotification(result(body, 'large'), subjects)

    expect(done?.metadata.toolOutput).toContain('RESULT-HEAD')
    expect(done?.metadata.toolOutput).toContain('RESULT-TAIL')
    expect(done?.metadata.toolOutput).toContain(TOOL_EVIDENCE_OMISSION.trim())
    expect((done?.metadata.toolOutput as string).length).toBeLessThanOrEqual(TOOL_EVIDENCE_MAX_CHARS)
    expect(done?.metadata.toolOutputHash).toMatch(/^[0-9a-f]{16}$/)
  })
  it('deduplicates identical result bodies within one AgentRun', () => {
    const subjects = new ToolTraceSubjects()
    const body = 'same grep result\nline-1\nline-2'
    start(subjects, { command: 'rg one' }, 'bash', 'first')
    const [first] = normalizeHarnessTraceNotification(result(body, 'first'), subjects)
    start(subjects, { command: 'rg two' }, 'bash', 'second')
    const [second] = normalizeHarnessTraceNotification(result(body, 'second'), subjects)

    expect(first?.metadata.toolOutput).toBe(body)
    expect(second?.metadata.toolOutput).toBeUndefined()
    expect(second?.metadata.toolOutputDuplicateOf).toBe('first')
    expect(second?.metadata.toolOutputHash).toBe(first?.metadata.toolOutputHash)
  })
  it('bounds oversized tool-call parameters and marks the clipped detail', () => {
    const subjects = new ToolTraceSubjects()
    const [call] = start(subjects, { command: `${'echo head\n'}${'x'.repeat(10_000)}echo tail` }, 'bash', 'args')

    expect(call?.metadata.toolDetail).toContain('echo head')
    expect(call?.metadata.toolDetail).toContain('echo tail')
    expect(call?.metadata.toolDetailTruncated).toBe(true)
    expect((call?.metadata.toolDetail as string).length).toBeLessThanOrEqual(TOOL_EVIDENCE_MAX_CHARS)
  })
  it('shows developer command output and arbitrary script dumps alike', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { command: 'pnpm test' }, 'bash')
    expect(normalizeHarnessTraceNotification(result('13 passed'), subjects)[0]?.metadata.toolOutput).toBe('13 passed')
    start(subjects, { command: 'node -e "console.log(process.env)"' }, 'bash')
    expect(normalizeHarnessTraceNotification(result('SECRET-DUMP-AS-IS'), subjects)[0]?.metadata.toolOutput).toBe('SECRET-DUMP-AS-IS')
  })
  it('retains explicitly reported exit code without guessing one from success', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { command: 'git status' }, 'bash')
    const [done] = normalizeHarnessTraceNotification(event('tool/result', { message: { source: { callId: 'c' }, content: [] }, meta: { exitCode: 3 } }), subjects)
    expect(done?.metadata.toolExitCode).toBe(3)
    expect(normalizeHarnessNotification(result('ok'))[0]?.metadata.toolExitCode).toBeUndefined()
  })
  it('keeps the original normalizer usable directly as an Array callback', () => {
    expect(() => [event('tool/call', { name: 'read', callId: 'c', arguments: '{}' }), result('ok')].flatMap(normalizeHarnessNotification)).not.toThrow()
  })
})

it('projects native observed diff hunks verbatim', () => {
  const subjects = new ToolTraceSubjects()
  start(subjects, { file_path: 'src/index.ts', old_string: 'PROPOSED-ONLY' }, 'edit')
  const [done] = normalizeHarnessTraceNotification(event('tool/result', { message: { source: { callId: 'c' }, content: [] }, meta: { diffs: [{ path: 'src/index.ts', oldText: 'const n = 1', newText: 'const n = 2' }] } }), subjects)
  expect(done?.metadata.toolOutput).toContain('const n = 1')
  expect(done?.metadata.toolOutput).toContain('const n = 2')
  expect(done?.metadata.toolOutput).not.toContain('PROPOSED-ONLY')
  start(subjects, { file_path: 'innocent-link' }, 'read')
  const [aliased] = normalizeHarnessTraceNotification(event('tool/result', { message: { source: { callId: 'c' }, content: [{ type: 'text', text: 'PRIVATE-ALIAS-CONTENT' }] }, meta: { path: '/private/.env' } }), subjects)
  expect(aliased?.metadata.toolOutput).toBe('PRIVATE-ALIAS-CONTENT')
})
