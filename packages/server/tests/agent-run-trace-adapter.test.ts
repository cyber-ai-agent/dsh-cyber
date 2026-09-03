import { describe, expect, it } from 'vitest'

import type { AgentRun, ModelInteractionLog, WorkMessage } from '@dsh-cyber/contracts'

import { AgentRunTraceAdapter } from '../src/world-trace/agent-run-trace-adapter.js'

describe('AgentRunTraceAdapter tool steps', () => {
  it('measures a tool step from call to result timestamps', () => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: {
        worldId: 'world-1',
        run: { id: 'run-tools', workspaceId: 'workspace-1', worldId: 'world-1', turnId: 'turn-1', sessionId: 'session-1', employeeId: 'employee-1', ordinal: 1, status: 'completed', createdAt: '2026-08-29T12:20:01.000Z' } as AgentRun,
        messages: [
          { id: 'm-call', kind: 'tool-call', content: 'read_file', metadata: { agentRunId: 'run-tools', callId: 'c1', toolName: 'read_file' }, createdAt: '2026-08-29T12:20:02.000Z' },
          { id: 'm-result', kind: 'tool-result', content: 'ok', metadata: { agentRunId: 'run-tools', callId: 'c1', failed: false }, createdAt: '2026-08-29T12:20:06.500Z' },
        ] as unknown as WorkMessage[],
      },
    })
    expect(entry?.tools?.[0]).toMatchObject({ callId: 'c1', status: 'success', durationMs: 4_500 })
  })

  it('uses the redacted call summary as the description and keeps the detail as input', () => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: {
        worldId: 'world-1',
        run: { id: 'run-tools', workspaceId: 'workspace-1', worldId: 'world-1', turnId: 'turn-1', sessionId: 'session-1', employeeId: 'employee-1', ordinal: 1, status: 'completed', createdAt: '2026-08-29T12:20:01.000Z' } as AgentRun,
        messages: [
          { id: 'm-call', kind: 'tool-call', content: 'bash', metadata: { agentRunId: 'run-tools', callId: 'c1', toolName: 'bash', toolSummary: 'git status', toolDetail: 'git status' }, createdAt: '2026-08-29T12:20:02.000Z' },
          { id: 'm-result', kind: 'tool-result', content: 'ok', metadata: { agentRunId: 'run-tools', callId: 'c1', failed: false }, createdAt: '2026-08-29T12:20:04.000Z' },
        ] as unknown as WorkMessage[],
      },
    })
    expect(entry?.tools?.[0]).toMatchObject({
      callId: 'c1',
      name: 'bash',
      label: '执行本地命令',
      description: 'git status',
      input: 'git status',
      status: 'success',
    })
  })

  it('falls back to the generic presentation when no summary was recorded', () => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: {
        worldId: 'world-1',
        run: { id: 'run-tools', workspaceId: 'workspace-1', worldId: 'world-1', turnId: 'turn-1', sessionId: 'session-1', employeeId: 'employee-1', ordinal: 1, status: 'completed', createdAt: '2026-08-29T12:20:01.000Z' } as AgentRun,
        messages: [
          { id: 'm-call', kind: 'tool-call', content: 'read_file', metadata: { agentRunId: 'run-tools', callId: 'c1', toolName: 'read_file' }, createdAt: '2026-08-29T12:20:02.000Z' },
        ] as unknown as WorkMessage[],
      },
    })
    expect(entry?.tools?.[0]).toMatchObject({ description: '读取文件内容用于分析或处理' })
    expect(entry?.tools?.[0]).not.toHaveProperty('input')
  })
})

const run: AgentRun = {
  id: 'run-timeout-detail',
  workspaceId: 'workspace-1',
  worldId: 'world-1',
  turnId: 'turn-1',
  sessionId: 'session-1',
  employeeId: 'employee-1',
  ordinal: 1,
  status: 'failed',
  errorCode: 'RATE_LIMIT',
  createdAt: '2026-08-29T12:20:01.000Z',
  startedAt: '2026-08-29T12:20:01.000Z',
  completedAt: '2026-08-29T12:20:31.000Z',
}

function interaction(input: Partial<ModelInteractionLog>): ModelInteractionLog {
  return {
    id: 'interaction-1',
    workspaceId: run.workspaceId,
    worldId: run.worldId,
    sessionId: run.sessionId,
    employeeId: run.employeeId,
    workTurnId: run.turnId,
    agentRunId: run.id,
    source: 'turn',
    modelId: 'sensenova-u1-fast',
    provider: 'sensenova-u1-fast',
    status: 'failed',
    promptMessageCount: 1,
    promptCharCount: 397,
    durationMs: 30_077,
    createdAt: '2026-08-29T12:20:01.000Z',
    ...input,
  }
}

describe('AgentRunTraceAdapter task and context links', () => {
  const completed: AgentRun = { ...run, id: 'run-linked', status: 'completed', errorCode: undefined as never }

  it('carries the real task id and title when the run was recorded against a task', () => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: { worldId: run.worldId, run: completed, messages: [], task: { id: 'task-77', title: '整理季度复盘' } },
    })
    expect(entry).toMatchObject({ runId: 'run-linked', workTurnId: 'turn-1', taskId: 'task-77', taskTitle: '整理季度复盘' })
  })

  it('carries no task at all for a plain chat run — never a turn id in disguise', () => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: { worldId: run.worldId, run: completed, messages: [] },
    })
    expect(entry).not.toHaveProperty('taskId')
    expect(entry).not.toHaveProperty('taskTitle')
    expect(JSON.stringify(entry)).not.toContain('turn:')
    expect(entry?.workTurnId).toBe('turn-1')
  })

  it('passes the snapshot numbers through untouched and omits them when there is no snapshot', () => {
    const context = {
      totalTokenEstimate: 450,
      layers: [{ kind: 'stable-identity' as const, tokenEstimate: 320 }, { kind: 'current-request' as const, tokenEstimate: 130 }],
      memoryHitCount: 2,
      stablePrefixTokens: 320,
      volatileTokens: 130,
      prefixReused: true,
    }
    const [withContext] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: { worldId: run.worldId, run: completed, messages: [], context },
    })
    expect(withContext?.context).toEqual(context)
    const [without] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: { worldId: run.worldId, run: completed, messages: [] },
    })
    expect(without).not.toHaveProperty('context')
  })
})

describe('AgentRunTraceAdapter failure details', () => {
  it('does not present a delayed 429 response as a local timeout', () => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: {
        worldId: run.worldId,
        run,
        messages: [],
        interaction: interaction({
          errorCode: 'RATE_LIMIT',
          errorMessage: '429: All available accounts are currently rate-limited. Please retry later.',
          httpStatus: 429,
        }),
      },
    })

    expect(entry).toMatchObject({
      status: 'failed',
      durationMs: 30_077,
      detail: '模型服务当前限流，上游暂无可用账户。请稍后重试或切换模型。',
    })
    expect(entry?.detail).not.toContain('超时')
  })

  it.each([
    [{ errorCode: 'AUTHENTICATION', httpStatus: 401 }, '模型服务认证失败'],
    [{ errorCode: 'MODEL_NOT_FOUND', httpStatus: 404 }, '当前模型不存在或无权访问'],
    [{ errorCode: 'TIMEOUT', httpStatus: 504 }, '模型服务响应超时'],
  ] as const)('projects common provider failures as actionable copy', (failure, expected) => {
    const [entry] = new AgentRunTraceAdapter().adapt({
      kind: 'agent-run',
      value: { worldId: run.worldId, run: { ...run, errorCode: failure.errorCode }, messages: [], interaction: interaction(failure) },
    })
    expect(entry?.detail).toContain(expected)
  })
})
