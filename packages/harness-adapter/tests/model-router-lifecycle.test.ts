import { describe, expect, it } from 'vitest'

import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeInstance,
  EmployeeRevision,
} from '@dsh-cyber/contracts'

import { HarnessModelRouter, type HarnessModelRoute } from '../src/index.js'

const employee: EmployeeInstance = {
  id: 'router-employee',
  workspaceId: 'router-workspace',
  worldId: 'router-world',
  blueprintId: 'router-role',
  blueprintVersion: 1,
  displayName: '路由角色',
  role: '模型路由测试角色',
  status: 'available',
  currentRevision: 1,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
}

const revision: EmployeeRevision = {
  employeeId: employee.id,
  revision: 1,
  persona: '只报告可验证事实。',
  skillGrants: [],
  capabilityGrants: [],
  modelPolicy: {},
  reason: 'router-test',
  createdAt: '2026-09-05T00:00:00.000Z',
}

function route(id: string, modelId = id): HarnessModelRoute {
  return {
    id,
    displayName: id,
    api: 'openai-completions',
    baseURL: `http://127.0.0.1/${id}`,
    modelId,
    reasoningEfforts: false,
  }
}

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    agent: employee,
    revision,
    conversationId: 'router-conversation',
    history: [],
    observedThroughSequence: 0,
    reasoningEffort: 'max',
    prompt: '执行路由测试',
    workspacePath: 'C:\\router-world',
    ...overrides,
  }
}

function failedEvent(metadata: Record<string, unknown> = {
  httpStatus: 503,
  errorCode: 'upstream_unreachable',
}): AgentRuntimeEvent {
  return {
    kind: 'turn.failed',
    source: 'router-test',
    sourceSessionId: 'router-session',
    failed: true,
    metadata,
  }
}

function completed(finalResponse = '完成'): AgentRuntimeEvent {
  return {
    kind: 'turn.completed',
    source: 'router-test',
    sourceSessionId: 'router-session',
    metadata: {},
    failed: false,
    content: finalResponse,
  }
}

function result(finalResponse = '完成') {
  return {
    agentSessionId: 'router-session',
    finalResponse,
    eventCount: 1,
  }
}

describe('Harness model router lifecycle', () => {
  it('limits recovery to two awaited attempts and normalizes each request', async () => {
    const seen: Array<{ reasoningEffort: AgentTurnRequest['reasoningEffort']; onEvent?: AgentTurnRequest['onEvent'] }> = []
    let runs = 0
    let resets = 0
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        seen.push({ reasoningEffort: input.reasoningEffort, onEvent: input.onEvent })
        input.onEvent?.(failedEvent())
        if (runs === 1) return result('第一次失败')
        throw new Error('gateway timeout')
      },
      async resetSession() { resets += 1 },
      async close() {},
    }
    const events: AgentRuntimeEvent[] = []
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => adapter,
    })

    await expect(router.runTurn(request({ onEvent: (event) => events.push(event) }))).rejects.toThrow('gateway timeout')
    expect(runs).toBe(2)
    expect(resets).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen.map((attempt) => attempt.reasoningEffort)).toEqual([undefined, undefined])
    expect(seen[0]?.onEvent).toBeTypeOf('function')
    expect(seen[1]?.onEvent).toBeTypeOf('function')
    // The first failure was intentionally held back while retrying; only the
    // terminal failure from the retry is surfaced.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'turn.failed' })
    await router.close()
  })

  it('keeps the approval run map while an awaited reset is in progress', async () => {
    let resetCalls = 0
    let runs = 0
    let releaseRetry!: () => void
    let retryStartedResolve!: () => void
    const retryStarted = new Promise<void>((resolve) => {
      // The second adapter call must stay pending. If runTurn returns that
      // Promise without awaiting it, the router's finally block drops this
      // mapping before the approval decision can arrive.
      retryStartedResolve = resolve
    })
    const decisions: string[] = []
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        if (runs === 1) {
          input.onEvent?.(failedEvent())
          return result('需要恢复')
        }
        input.onEvent?.({
          kind: 'approval.requested',
          source: 'router-test',
          sourceSessionId: 'router-session',
          toolName: 'write_file',
          metadata: { approvalRequestId: 'approval-retry' },
        })
        retryStartedResolve()
        await new Promise<void>((resolve) => { releaseRetry = resolve })
        input.onEvent?.(completed('恢复完成'))
        return result('恢复完成')
      },
      async resetSession() { resetCalls += 1 },
      async decideApproval(agentRunId, approvalRequestId, decision) {
        decisions.push(`${agentRunId}:${approvalRequestId}:${decision}`)
      },
      async close() {},
    }
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => adapter,
    })
    const events: AgentRuntimeEvent[] = []
    const running = router.runTurn(request({
      agentRunId: 'router-run-approval',
      onEvent: (event) => events.push(event),
    }))
    await retryStarted
    await router.decideApproval('router-run-approval', 'approval-retry', 'approved')
    expect(decisions).toEqual(['router-run-approval:approval-retry:approved'])
    releaseRetry()
    await expect(running).resolves.toMatchObject({ finalResponse: '恢复完成' })
    expect(resetCalls).toBe(1)
    expect(runs).toBe(2)
    expect(events.some((event) => event.kind === 'turn.failed')).toBe(false)
    expect(events.map((event) => event.kind)).toEqual(['approval.requested', 'turn.completed'])
    await expect(router.decideApproval('router-run-approval', 'approval-retry', 'approved')).rejects.toThrow('审批对应的运行回合已经结束')
    await router.close()
  })

  it('does not resurrect a cancelled run after reset resolves', async () => {
    let releaseReset!: () => void
    const resetStarted = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    let runs = 0
    let aborts = 0
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        input.onEvent?.(failedEvent())
        return result('失败')
      },
      async resetSession() {
        await resetStarted
      },
      async abortRun() { aborts += 1 },
      async close() {},
    }
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => adapter,
    })
    const running = router.runTurn(request({ agentRunId: 'router-run-cancel' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await router.abortRun('router-run-cancel')
    releaseReset()
    await expect(running).rejects.toThrow('Agent run aborted')
    expect(aborts).toBe(1)
    expect(runs).toBe(1)
    await router.close()
  })

  it('single-flights generation acquisition for concurrent turns', async () => {
    let factoryCalls = 0
    let releaseRuns!: () => void
    const runsReleased = new Promise<void>((resolve) => {
      releaseRuns = resolve
    })
    let activeRuns = 0
    const adapter: AgentRuntimePort = {
      async runTurn() {
        activeRuns += 1
        await runsReleased
        activeRuns -= 1
        return result()
      },
      async close() {},
    }
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => {
        factoryCalls += 1
        return adapter
      },
    })
    const first = router.runTurn(request({ prompt: '第一轮' }))
    const second = router.runTurn(request({ prompt: '第二轮' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(activeRuns).toBe(2)
    expect(factoryCalls).toBe(1)
    releaseRuns()
    await Promise.all([first, second])
    await router.close()
  })

  it('lets a retired generation drain and closes it once', async () => {
    let selected: HarnessModelRoute = route('router-model', 'model-a')
    const releases = new Map<string, () => void>()
    const closeCalls = new Map<string, number>()
    const adapters = new Map<string, AgentRuntimePort>()
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => selected,
      adapterFactory: (options) => {
        const model = options.model ?? 'default'
        const adapter: AgentRuntimePort = {
          async runTurn() {
            await new Promise<void>((resolve) => releases.set(model, resolve))
            return result(model)
          },
          async close() {
            closeCalls.set(model, (closeCalls.get(model) ?? 0) + 1)
          },
        }
        adapters.set(model, adapter)
        return adapter
      },
    })
    const oldRun = router.runTurn(request({ prompt: '旧代' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    selected = route('router-model', 'model-b')
    const newRun = router.runTurn(request({ prompt: '新代' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(closeCalls.get('model-a') ?? 0).toBe(0)
    releases.get('model-b')?.()
    await newRun
    expect(closeCalls.get('model-a') ?? 0).toBe(0)
    releases.get('model-a')?.()
    await oldRun
    for (let tick = 0; tick < 3; tick += 1) await Promise.resolve()
    expect(closeCalls.get('model-a')).toBe(1)
    await router.close()
    expect(closeCalls.get('model-a')).toBe(1)
    expect(closeCalls.get('model-b')).toBe(1)
    expect(adapters.size).toBe(2)
  })

  it('keeps a retry pinned to its acquired generation across a route update', async () => {
    let selected: HarnessModelRoute = route('router-model', 'model-a')
    let releaseReset!: () => void
    let markResetInvoked!: () => void
    const resetStarted = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    const resetInvoked = new Promise<void>((resolve) => {
      markResetInvoked = resolve
    })
    const runCalls = new Map<string, number>()
    const closeCalls = new Map<string, number>()
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => selected,
      adapterFactory: (options) => {
        const model = options.model ?? 'default'
        return {
          async runTurn(input) {
            const calls = (runCalls.get(model) ?? 0) + 1
            runCalls.set(model, calls)
            if (model === 'model-a' && calls === 1) {
              input.onEvent?.(failedEvent())
              return result('旧代失败')
            }
            return result(`${model}:${calls}`)
          },
          async resetSession() {
            if (model === 'model-a') {
              markResetInvoked()
              await resetStarted
            }
          },
          async close() {
            closeCalls.set(model, (closeCalls.get(model) ?? 0) + 1)
          },
        }
      },
    })

    const oldRun = router.runTurn(request({ agentRunId: 'router-run-pinned' }))
    // The first attempt has entered its awaited reset. Install a new route
    // generation while the old turn is still leased.
    await resetInvoked
    selected = route('router-model', 'model-b')
    await expect(router.runTurn(request({ prompt: '新配置' }))).resolves.toMatchObject({
      finalResponse: 'model-b:1',
    })
    expect(runCalls).toEqual(new Map([['model-a', 1], ['model-b', 1]]))
    expect(closeCalls.get('model-a') ?? 0).toBe(0)

    releaseReset()
    await expect(oldRun).resolves.toMatchObject({ finalResponse: 'model-a:2' })
    await Promise.resolve()
    expect(runCalls.get('model-a')).toBe(2)
    expect(closeCalls.get('model-a')).toBe(1)
    await router.close()
    expect(closeCalls.get('model-a')).toBe(1)
    expect(closeCalls.get('model-b')).toBe(1)
  })

  it('does not restart a retry when router shutdown wins during reset', async () => {
    let releaseReset!: () => void
    let markResetInvoked!: () => void
    const resetStarted = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    const resetInvoked = new Promise<void>((resolve) => {
      markResetInvoked = resolve
    })
    let runs = 0
    let closes = 0
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        input.onEvent?.(failedEvent())
        return result('待恢复')
      },
      async resetSession() {
        markResetInvoked()
        await resetStarted
      },
      async close() { closes += 1 },
    }
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => adapter,
    })
    const running = router.runTurn(request({ agentRunId: 'router-run-shutdown' }))
    await resetInvoked
    const closing = router.close()
    releaseReset()
    await expect(running).rejects.toThrow('Agent run aborted')
    await closing
    expect(runs).toBe(1)
    expect(closes).toBe(1)
  })

  it('recovers from a failed adapter factory and prevents creation after close', async () => {
    let factoryCalls = 0
    let closeCalls = 0
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => {
        factoryCalls += 1
        if (factoryCalls === 1) throw new Error('factory temporarily unavailable')
        return {
          async runTurn() { return result('恢复') },
          async close() { closeCalls += 1 },
        }
      },
    })

    await expect(router.runTurn(request())).rejects.toThrow('factory temporarily unavailable')
    await expect(router.runTurn(request())).resolves.toMatchObject({ finalResponse: '恢复' })
    expect(factoryCalls).toBe(2)
    await router.close()
    expect(closeCalls).toBe(1)
    await expect(router.runTurn(request())).rejects.toThrow('Harness model router closed')
    expect(factoryCalls).toBe(2)
  })

  it('does not retry after an approval request has been emitted', async () => {
    let runs = 0
    let resets = 0
    const adapter: AgentRuntimePort = {
      async runTurn(input) {
        runs += 1
        input.onEvent?.({
          kind: 'approval.requested',
          source: 'router-test',
          sourceSessionId: 'router-session',
          toolName: 'write_file',
          metadata: { approvalRequestId: 'approval-1' },
        })
        input.onEvent?.(failedEvent())
        return result('审批失败')
      },
      async resetSession() { resets += 1 },
      async close() {},
    }
    const events: AgentRuntimeEvent[] = []
    const router = new HarnessModelRouter({
      stateRoot: 'C:\\router-runtime',
      resolveRoute: () => route('router-model'),
      adapterFactory: () => adapter,
    })

    await router.runTurn(request({ onEvent: (event) => events.push(event) }))
    expect(runs).toBe(1)
    expect(resets).toBe(0)
    expect(events.map((event) => event.kind)).toEqual(['approval.requested', 'turn.failed'])
    await router.close()
  })
})
