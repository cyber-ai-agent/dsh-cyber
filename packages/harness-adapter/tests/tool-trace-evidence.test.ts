import { describe, expect, it } from 'vitest'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { normalizeHarnessNotification, normalizeHarnessTraceNotification } from '../src/adapter.js'
import { ToolTraceSubjects } from '../src/tool-result-summary.js'
import { summarizeToolCall } from '../src/tool-summary.js'

function event(type: string, data: object, sessionId = 's'): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data, seq: 1, time: 1 } } } as HarnessNotification
}
function result(text: string, callId = 'c', sessionId = 's') {
  return event('tool/result', { message: { source: { callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }] } }, sessionId)
}
function start(subjects: ToolTraceSubjects, args: object, name = 'read', callId = 'c', sessionId = 's') {
  return normalizeHarnessTraceNotification(event('tool/call', { name, callId, arguments: JSON.stringify(args) }, sessionId), subjects)
}

describe('scoped tool evidence from real rc.1 event shapes', () => {
  it('preserves long code filenames and real read ranges', () => {
    const summary = summarizeToolCall({ file_path: 'packages/server/src/services/character-profile-runtime.ts', offset: 10, limit: 25 })!
    expect(summary.summary).toContain('character-profile-runtime.ts')
    expect(summary.detail).toContain('offset=10')
    expect(summary.detail).toContain('limit=25')
  })
  it('keeps actual nested text results and never raw input bodies', () => {
    const subjects = new ToolTraceSubjects()
    const [call] = start(subjects, { file_path: 'src/token-counter.ts', content: 'DO-NOT-LOG-RAW-INPUT' })
    expect(JSON.stringify(call)).not.toContain('DO-NOT-LOG-RAW-INPUT')
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
  it('keeps secret filenames visible but suppresses credential container contents', () => {
    const subjects = new ToolTraceSubjects()
    expect(start(subjects, { file_path: '.env' })[0]?.metadata.toolSummary).toBe('.env')
    const value = normalizeHarnessTraceNotification(result('UNLABELED-PRIVATE-VALUE'), subjects)[0]
    expect(JSON.stringify(value)).not.toContain('UNLABELED-PRIVATE-VALUE')
    expect(value?.metadata.toolOutputRedacted).toBe(true)
  })
  it('redacts values and clips large results with explicit flags', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { file_path: 'src/index.ts' })
    const [done] = normalizeHarnessTraceNotification(result('access_token="opaque private value"\n' + 'x'.repeat(40_000)), subjects)
    expect(done?.metadata.toolOutput).not.toContain('opaque private')
    expect((done?.metadata.toolOutput as string).length).toBeLessThanOrEqual(4_000)
    expect(done?.metadata.toolOutputTruncated).toBe(true)
    expect(done?.metadata.toolOutputRedacted).toBe(true)
  })
  it('shows real safe developer command output and suppresses arbitrary script dumps', () => {
    const subjects = new ToolTraceSubjects()
    start(subjects, { command: 'pnpm test' }, 'bash')
    expect(normalizeHarnessTraceNotification(result('13 passed'), subjects)[0]?.metadata.toolOutput).toBe('13 passed')
    start(subjects, { command: 'node -e "console.log(process.env)"' }, 'bash')
    expect(JSON.stringify(normalizeHarnessTraceNotification(result('UNLABELED-SECRET'), subjects))).not.toContain('UNLABELED-SECRET')
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

it('projects native observed diff hunks and suppresses the canonical target of a secret-file alias', () => {
  const subjects = new ToolTraceSubjects()
  start(subjects, { file_path: 'src/index.ts', old_string: 'PROPOSED-ONLY' }, 'edit')
  const [done] = normalizeHarnessTraceNotification(event('tool/result', { message: { source: { callId: 'c' }, content: [] }, meta: { diffs: [{ path: 'src/index.ts', oldText: 'const n = 1', newText: 'const n = 2' }] } }), subjects)
  expect(done?.metadata.toolOutput).toContain('const n = 1')
  expect(done?.metadata.toolOutput).toContain('const n = 2')
  expect(done?.metadata.toolOutput).not.toContain('PROPOSED-ONLY')
  start(subjects, { file_path: 'innocent-link' }, 'read')
  const [denied] = normalizeHarnessTraceNotification(event('tool/result', { message: { source: { callId: 'c' }, content: [{ type: 'text', text: 'PRIVATE-ALIAS-CONTENT' }] }, meta: { path: '/private/.env' } }), subjects)
  expect(JSON.stringify(denied)).not.toContain('PRIVATE-ALIAS-CONTENT')
})
