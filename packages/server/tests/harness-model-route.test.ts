import type { ModelProfile } from '@dsh-cyber/contracts'
import { describe, expect, it } from 'vitest'

import { harnessModelRoute, supportedReasoningEffort } from '../src/services/harness-model-route.js'

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-1',
    workspaceId: 'workspace-1',
    displayName: 'DeepSeek',
    providerKind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    api: 'openai-completions',
    credentialEnvName: 'DSH_CYBER_MODEL_KEY_TEST',
    isDefault: true,
    settings: {},
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  }
}

describe('harnessModelRoute', () => {
  it('only binds web search when the model profile explicitly enables a compatible endpoint', () => {
    expect(harnessModelRoute(profile())).not.toHaveProperty('webSearch')
    expect(harnessModelRoute(profile({
      settings: {
        webSearchEnabled: true,
        webSearchBaseUrl: 'https://api.deepseek.com/anthropic/v1',
      },
    }))).toMatchObject({
      webSearch: {
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        apiKeyEnv: 'DSH_CYBER_MODEL_KEY_TEST',
      },
    })
  })

  it('keeps a requested effort the profile declares', () => {
    const route = harnessModelRoute(profile({
      settings: { reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high' } },
    }), 'medium')
    expect(route.reasoning).toBe('medium')
    expect(route.reasoningEfforts).toMatchObject({ medium: 'medium' })
  })

  it('degrades an undeclared effort to no explicit reasoning instead of failing the turn', () => {
    const route = harnessModelRoute(profile({
      settings: { reasoningEfforts: { off: 'none', low: 'low' } },
    }), 'max')
    expect(route.reasoning).toBeUndefined()
    expect(supportedReasoningEffort(profile({ settings: {} }), 'medium')).toBe('medium')
    expect(harnessModelRoute(profile({ settings: {} }), 'medium').reasoning).toBe('medium')
  })

  it('drops every effort for a declared non-reasoning model', () => {
    const nonReasoning = profile({ settings: { reasoningEfforts: false } })
    expect(harnessModelRoute(nonReasoning, 'medium')).not.toHaveProperty('reasoning')
    expect(harnessModelRoute(nonReasoning)).not.toHaveProperty('reasoning')
    expect(supportedReasoningEffort(nonReasoning, 'off')).toBeUndefined()
  })
})
