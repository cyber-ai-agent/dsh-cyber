import { describe, expect, it } from 'vitest'

import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeInstance,
  EmployeeRevision,
} from '@dsh-cyber/contracts'

import { HarnessModelRouter, isTransientRuntimeFailure } from '../src/index.js'

const employee: EmployeeInstance = {
  id: 'character-1',
  workspaceId: 'workspace-1',
  worldId: 'world-1',
  blueprintId: 'custom-role',
  blueprintVersion: 1,
  displayName: '小夏',
  role: '自定义角色',
  status: 'available',
  currentRevision: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}

const revision: EmployeeRevision = {
  employeeId: employee.id,
  revision: 1,
  persona: '保持简洁。',
  skillGrants: [],
  capabilityGrants: [],
  modelPolicy: {},
  reason: 'test',
  createdAt: '2026-08-23T00:00:00.000Z',
}

function request(events: AgentRuntimeEvent[]): AgentTurnRequest {
  return {
    agent: employee,
    revision,
    conversationId: 'conversation-1',
    history: [],
    observedThroughSequence: 0,
    prompt: '你好',
    workspacePath: '/tmp/world-1',
    onEvent: (event) => events.push(event),
  }
}

describe('Harness transient recovery', () => {
  it('resets only the affected character runtime and retries one transient 503 before output', async () => {
    let runs = 0
    const closedAgents: string[] = []
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        input.onEvent?.({
          kind: 'turn.started',
          source: 'test',
          sourceSessionId: 'session-1',
          metadata: {},
        })
        if (runs === 1) {
          input.onEvent?.({
            kind: 'turn.failed',
            source: 'test',
            sourceSessionId: 'session-1',
            failed: true,
            metadata: {
              httpStatus: 503,
              errorCode: 'upstream_unreachable',
              error: 'service unavailable',
            },
          })
          return { agentSessionId: 'session-1', finalResponse: '', eventCount: 2 }
        }
        input.onEvent?.({
          kind: 'assistant.message',
          source: 'test',
          sourceSessionId: 'session-1',
          content: '恢复成功',
          metadata: {},
        })
        return { agentSessionId: 'session-1', finalResponse: '恢复成功', eventCount: 1 }
      },
      async resetSession(agentId) { closedAgents.push(agentId) },
      async close() {},
    }
    const router = new HarnessModelRouter({
      stateRoot: '/tmp/runtime',
      resolveRoute: () => undefined,
      adapterFactory: () => adapter,
    })
    const events: AgentRuntimeEvent[] = []

    const result = await router.runTurn(request(events))

    expect(result.finalResponse).toBe('恢复成功')
    expect(runs).toBe(2)
    expect(closedAgents).toEqual([employee.id])
    expect(events.some((event) => event.kind === 'turn.failed')).toBe(false)
    expect(events.some((event) => event.kind === 'assistant.message')).toBe(true)
  })

  it('retries a thrown connection reset before any visible output', async () => {
    let runs = 0
    let resets = 0
    const adapter: AgentRuntimePort = {
      async runTurn() {
        runs += 1
        if (runs === 1) {
          const error = new Error('socket hang up ECONNRESET') as Error & { code?: string }
          error.code = 'ECONNRESET'
          throw error
        }
        return { agentSessionId: 'session-1', finalResponse: 'ok', eventCount: 0 }
      },
      async resetSession() { resets += 1 },
      async close() {},
    }
    const router = new HarnessModelRouter({
      stateRoot: '/tmp/runtime',
      resolveRoute: () => undefined,
      adapterFactory: () => adapter,
    })

    await expect(router.runTurn(request([]))).resolves.toMatchObject({ finalResponse: 'ok' })
    expect(runs).toBe(2)
    expect(resets).toBe(1)
  })

  it('does not retry authentication, rate-limit, or failures after visible output/tool execution', async () => {
    expect(isTransientRuntimeFailure({ httpStatus: 401, errorCode: 'invalid_api_key' })).toBe(false)
    expect(isTransientRuntimeFailure({ httpStatus: 429, errorCode: 'rate_limit' })).toBe(false)
    expect(isTransientRuntimeFailure({ httpStatus: 504, errorCode: 'gateway_timeout' })).toBe(true)

    let runs = 0
    let resets = 0
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        input.onEvent?.({
          kind: 'assistant.message',
          source: 'test',
          sourceSessionId: 'session-1',
          content: '部分回复',
          metadata: {},
        })
        input.onEvent?.({
          kind: 'turn.failed',
          source: 'test',
          sourceSessionId: 'session-1',
          failed: true,
          metadata: { httpStatus: 503, errorCode: 'upstream_unreachable' },
        })
        return { agentSessionId: 'session-1', finalResponse: '部分回复', eventCount: 2 }
      },
      async resetSession() { resets += 1 },
      async close() {},
    }
    const router = new HarnessModelRouter({
      stateRoot: '/tmp/runtime',
      resolveRoute: () => undefined,
      adapterFactory: () => adapter,
    })
    const events: AgentRuntimeEvent[] = []

    await router.runTurn(request(events))

    expect(runs).toBe(1)
    expect(resets).toBe(0)
    expect(events.map((event) => event.kind)).toEqual(['assistant.message', 'turn.failed'])
  })
})
