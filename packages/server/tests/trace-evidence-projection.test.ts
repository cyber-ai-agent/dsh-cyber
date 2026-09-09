import { describe, expect, it } from 'vitest'
import type { AgentRun, WorkMessage } from '@dsh-cyber/contracts'
import { AgentRunTraceAdapter } from '../src/world-trace/agent-run-trace-adapter.js'
import { RuntimeEventTraceAdapter } from '../src/world-trace/runtime-event-trace-adapter.js'
import { TraceSanitizer } from '../src/world-trace/trace-sanitizer.js'

const meta = { toolOutput: 'native result\npassword=opaque-credential', toolOutputTruncated: true, toolExitCode: 2 }
const run = { id: 'run', employeeId: 'self', sessionId: 'session', turnId: 'turn', status: 'completed', createdAt: '2026-09-07T00:00:00Z' } as AgentRun
function historical() {
  return new AgentRunTraceAdapter().adapt({ kind: 'agent-run', value: { worldId: 'world', run, messages: [
    { id: 'call', kind: 'tool-call', content: 'read', metadata: { agentRunId: 'run', callId: 'c', toolName: 'read', toolSummary: 'src/keyboard-shortcuts.ts', toolDetail: 'src/keyboard-shortcuts.ts' }, createdAt: '2026-09-07T00:00:00Z' },
    { id: 'result', kind: 'tool-result', content: 'done', metadata: { ...meta, agentRunId: 'run', callId: 'c', failed: false }, createdAt: '2026-09-07T00:00:01Z' },
  ] as WorkMessage[] } })[0]!
}
describe('persistent and live tool evidence projections', () => {
  it('keeps recorded targets, raw multiline results and measured elapsed time after a reload', () => {
    const entry = new TraceSanitizer().entry(historical())
    expect(entry.tools?.[0]).toMatchObject({ name: 'read', label: '读取文件', input: 'src/keyboard-shortcuts.ts', durationMs: 1000, outputTruncated: true, exitCode: 2 })
    expect(entry.tools?.[0]?.output).toContain('native result\n')
    // Raw results are shown verbatim in the trace; no credential masking.
    expect(entry.tools?.[0]?.output).toContain('opaque-credential')
  })
  it('projects the same output fields in live events and applies the same exit clip', () => {
    const entry = new RuntimeEventTraceAdapter().adapt({ kind: 'runtime-event', value: { worldId: 'world', actorId: 'self', sessionId: 'session', agentRunId: 'run', createdAt: run.createdAt, event: { kind: 'tool.completed', source: 'harness', sourceSessionId: 'native', callId: 'c', toolName: 'read', metadata: meta } } })[0]!
    const safe = new TraceSanitizer().entry(entry)
    expect(safe.tools?.[0]?.output).toBe(new TraceSanitizer().entry(historical()).tools?.[0]?.output)
    expect(safe.tools?.[0]?.exitCode).toBe(2)
  })
  it('clips unbounded foreign-adapter output without hiding its content', () => {
    const entry = historical()
    entry.tools![0]!.output = 'x'.repeat(1_000_000)
    const clipped = new TraceSanitizer().entry(entry).tools?.[0]?.output
    expect(clipped?.length).toBeLessThanOrEqual(32_000)
    expect(clipped).toContain('xx')
    expect(clipped).not.toContain('已隐藏')
    delete entry.tools![0]!.output
    expect(new TraceSanitizer().entry(entry).tools?.[0]).not.toHaveProperty('output')
  })
})
