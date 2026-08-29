import { describe, expect, it } from 'vitest'

import type { AgentRun, ModelInteractionLog } from '@dsh-cyber/contracts'

import { AgentRunTraceAdapter } from '../src/world-trace/agent-run-trace-adapter.js'

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
