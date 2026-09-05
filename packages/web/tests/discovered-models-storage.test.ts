import { describe, expect, it } from 'vitest'
import type { ModelProfile } from '@dsh-cyber/contracts'
import { buildUnifiedModelList, type CachedModelCatalog } from '../src/features/models/discovered-models-storage.js'

function profile(id: string, baseUrl: string): ModelProfile {
  return {
    id, workspaceId: 'workspace', displayName: id, modelId: 'shared-model',
    providerKind: 'openai-compatible-remote', baseUrl, api: 'openai-completions',
    isDefault: false, settings: {}, createdAt: '', updatedAt: '',
  }
}

describe('configured conversation model list', () => {
  it('does not expand configured profiles from active or deleted provider caches', () => {
    const profiles = [profile('active', 'https://active.example/v1')]
    const cache = {
      active: { baseUrl: profiles[0]!.baseUrl, updatedAt: 1, models: [{ id: 'shared-model' }, { id: 'discovered-only' }] },
      deleted: { baseUrl: 'https://removed.example/v1', updatedAt: 1, models: [{ id: 'stale-model' }] },
    }
    const result = buildUnifiedModelList(profiles, cache)
    expect(result).toEqual(profiles)
    expect(result).not.toBe(profiles)
    expect(cache.active.models).toHaveLength(2)
  })

  it('preserves independently configured providers that serve the same model ID', () => {
    const profiles = [profile('first', 'https://first.example/v1'), profile('second', 'https://second.example/v1')]
    expect(buildUnifiedModelList(profiles, {})).toEqual(profiles)
  })

  it.each([null, { removed: { models: [null, 42, {}] } }])('ignores malformed legacy cache data: %j', (cache) => {
    const profiles = [profile('active', 'https://active.example/v1')]
    expect(buildUnifiedModelList(profiles, cache as unknown as Record<string, CachedModelCatalog>)).toEqual(profiles)
    expect(buildUnifiedModelList([], cache as unknown as Record<string, CachedModelCatalog>)).toEqual([])
  })
})
