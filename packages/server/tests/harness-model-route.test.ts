import type { ModelProfile } from '@dsh-cyber/contracts'
import { describe, expect, it } from 'vitest'

import { harnessModelRoute } from '../src/services/harness-model-route.js'

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
})
