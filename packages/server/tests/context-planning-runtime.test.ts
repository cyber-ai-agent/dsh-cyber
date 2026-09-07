import { describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import { ContextInputTooLargeError, planContextBudget } from '@dsh-cyber/contracts'

import { ContextPlanningRuntime } from '../src/services/context-planning-runtime.js'

describe('ContextPlanningRuntime', () => {
  it('attaches a model-aware budget without changing durable history', async () => {
    const inner = new CaptureRuntime()
    const runtime = new ContextPlanningRuntime(inner, () => ({ contextWindow: 8_192, maxOutputTokens: 1_024 }))
    const request = turnRequest()

    await runtime.runTurn(request)

    expect(inner.request?.contextBudget).toMatchObject({ contextWindow: 8_192, maxOutputTokens: 1_024 })
    expect(inner.request?.contextBudget?.historyTokens).toBeGreaterThan(inner.request?.contextBudget?.memoryTokens ?? 0)
    expect(inner.request?.history).toEqual(request.history)
  })

  it('preserves an explicitly supplied plan', async () => {
    const inner = new CaptureRuntime()
    const runtime = new ContextPlanningRuntime(inner, () => ({ contextWindow: 4_096 }))
    const request = turnRequest()
    const contextBudget = { contextWindow: 16_384, maxOutputTokens: 2_048, safetyMarginTokens: 819, inputBudgetTokens: 13_517, fixedTokens: 20, workingTokens: 2_000, historyTokens: 7_000, memoryTokens: 1_800, knowledgeTokens: 2_697 }

    await runtime.runTurn({ ...request, contextBudget })

    expect(inner.request?.contextBudget).toBe(contextBudget)
  })

  it('refuses a reachable long chat before calling the inner model runtime', async () => {
    const inner = new CaptureRuntime()
    const runtime = new ContextPlanningRuntime(inner, () => ({ contextWindow: 4_096, maxOutputTokens: 1_024 }))
    const request = { ...turnRequest(), prompt: '中'.repeat(32_000) }
    await expect(runtime.runTurn(request)).rejects.toBeInstanceOf(ContextInputTooLargeError)
    expect(inner.request).toBeUndefined()
    expect(request.prompt).toHaveLength(32_000)
  })

  it('does not let a supplied plan bypass the fixed input check', async () => {
    const inner = new CaptureRuntime()
    const runtime = new ContextPlanningRuntime(inner, () => undefined)
    const request = { ...turnRequest(), contextBudget: planContextBudget({ contextWindow: 4_096, maxOutputTokens: 1_024 }), prompt: '中'.repeat(3_000) }
    await expect(runtime.runTurn(request)).rejects.toBeInstanceOf(ContextInputTooLargeError)
    expect(inner.request).toBeUndefined()
  })
})

class CaptureRuntime implements AgentRuntimePort {
  request: AgentTurnRequest | undefined
  async runTurn(request: AgentTurnRequest) { this.request = request; return { agentSessionId: 'session', finalResponse: 'ok', eventCount: 0 } }
  async close(): Promise<void> {}
}

function turnRequest(): AgentTurnRequest {
  return {
    agent: { id: 'employee', workspaceId: 'workspace', worldId: 'world', blueprintId: 'blueprint', blueprintVersion: 1, displayName: '员工', role: '工程师', status: 'available', currentRevision: 1, createdAt: '', updatedAt: '' },
    revision: { employeeId: 'employee', revision: 1, persona: '保持简洁并基于事实回答。', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: '' },
    conversationId: 'conversation', history: [{ role: 'user', sequence: 1, speakerId: 'owner', speakerName: '用户', content: '之前发生了什么？', createdAt: '' }],
    observedThroughSequence: 0, prompt: '继续', workspacePath: 'C:\\world',
  }
}
