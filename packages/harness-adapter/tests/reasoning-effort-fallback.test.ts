import { describe, expect, it } from 'vitest'

import type { AgentTurnRequest } from '@dsh-cyber/contracts'

import { withoutUnsupportedReasoningEffort, type HarnessModelRoute } from '../src/index.js'

function turnRequest(reasoningEffort?: AgentTurnRequest['reasoningEffort']): AgentTurnRequest {
  return {
    agent: { id: 'employee-1', workspaceId: 'ws-1', worldId: 'world-1' },
    revision: undefined as never,
    prompt: 'hello',
    workspacePath: 'G:/tmp/world',
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

describe('withoutUnsupportedReasoningEffort', () => {
  it('keeps a requested effort the routed model declares', () => {
    const route: HarnessModelRoute = {
      id: 'route-1',
      displayName: 'DeepSeek',
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-v4-flash',
      reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    }
    expect(withoutUnsupportedReasoningEffort(turnRequest('medium'), route).reasoningEffort).toBe('medium')
  })

  it('drops a requested effort the routed model does not declare', () => {
    const route: HarnessModelRoute = {
      id: 'route-1',
      displayName: 'DeepSeek',
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-v4-flash',
      reasoningEfforts: { off: 'none', low: 'low' },
    }
    const result = withoutUnsupportedReasoningEffort(turnRequest('max'), route)
    expect(result.reasoningEffort).toBeUndefined()
    expect(result.prompt).toBe('hello')
    expect(result.agent.id).toBe('employee-1')
  })

  it('drops every effort for a declared non-reasoning model', () => {
    const route: HarnessModelRoute = {
      id: 'route-2',
      displayName: 'sandaoliu',
      api: 'openai-completions',
      baseURL: 'https://sub.sandaoliu.cn/v1',
      modelId: 'sensenova-6.8-flash-lite',
      reasoningEfforts: false,
    }
    expect(withoutUnsupportedReasoningEffort(turnRequest('medium'), route).reasoningEffort).toBeUndefined()
    expect(withoutUnsupportedReasoningEffort(turnRequest('off'), route).reasoningEffort).toBeUndefined()
  })

  it('keeps the request untouched when the profile relies on catalog defaults or sends no effort', () => {
    const catalogRoute: HarnessModelRoute = {
      id: 'route-3',
      displayName: 'catalog',
      api: 'openai-completions',
      baseURL: 'https://example.invalid/v1',
      modelId: 'some-model',
    }
    expect(withoutUnsupportedReasoningEffort(turnRequest('high'), catalogRoute).reasoningEffort).toBe('high')
    expect(withoutUnsupportedReasoningEffort(turnRequest(), catalogRoute).reasoningEffort).toBeUndefined()
    expect(withoutUnsupportedReasoningEffort(turnRequest('low'), undefined).reasoningEffort).toBe('low')
  })
})
