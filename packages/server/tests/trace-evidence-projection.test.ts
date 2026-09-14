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
  it('keeps recorded targets, sanitized multiline results and measured elapsed time after a reload', () => {
    const entry = new TraceSanitizer().entry(historical())
    expect(entry.tools?.[0]).toMatchObject({ name: 'read', label: '读取文件', input: 'src/keyboard-shortcuts.ts', durationMs: 1000, outputTruncated: true, exitCode: 2 })
    expect(entry.tools?.[0]?.output).toContain('native result\n')
    expect(entry.tools?.[0]?.output).not.toContain('opaque-credential')
    expect(entry.tools?.[0]?.outputRedacted).toBe(true)
  })
  it('projects the same output fields in live events and applies the same exit clip', () => {
    const entry = new RuntimeEventTraceAdapter().adapt({ kind: 'runtime-event', value: { worldId: 'world', actorId: 'self', sessionId: 'session', agentRunId: 'run', createdAt: run.createdAt, event: { kind: 'tool.completed', source: 'harness', sourceSessionId: 'native', callId: 'c', toolName: 'read', metadata: meta } } })[0]!
    const safe = new TraceSanitizer().entry(entry)
    expect(safe.tools?.[0]?.output).toBe(new TraceSanitizer().entry(historical()).tools?.[0]?.output)
    expect(safe.tools?.[0]?.exitCode).toBe(2)
  })
  it('shows a compact reference when an identical result body was reused', () => {
    const entry = new AgentRunTraceAdapter().adapt({ kind: 'agent-run', value: { worldId: 'world', run, messages: [
      { id: 'call-1', kind: 'tool-call', content: 'read', metadata: { agentRunId: 'run', callId: 'c1', toolName: 'read', toolSummary: 'first' }, createdAt: '2026-09-07T00:00:00Z' },
      { id: 'result-1', kind: 'tool-result', content: 'done', metadata: { agentRunId: 'run', callId: 'c1', failed: false, toolOutput: 'same output' }, createdAt: '2026-09-07T00:00:01Z' },
      { id: 'call-2', kind: 'tool-call', content: 'read', metadata: { agentRunId: 'run', callId: 'c2', toolName: 'read', toolSummary: 'second', toolDetail: 'large', toolDetailTruncated: true }, createdAt: '2026-09-07T00:00:02Z' },
      { id: 'result-2', kind: 'tool-result', content: 'done', metadata: { agentRunId: 'run', callId: 'c2', failed: false, toolOutputDuplicateOf: 'c1' }, createdAt: '2026-09-07T00:00:03Z' },
    ] as WorkMessage[] } })[0]!
    const safe = new TraceSanitizer().entry(entry)

    expect(safe.tools?.[1]).toMatchObject({ inputTruncated: true, outputReference: 'c1' })
    expect(safe.tools?.[1]?.output).toBeUndefined()
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
