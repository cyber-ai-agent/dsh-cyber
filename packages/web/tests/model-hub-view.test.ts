import { describe, expect, it } from 'vitest'

import type { HubProfile, HubProvider } from '../src/features/model-hub/api.js'

import {
  capabilityTone,
  contextOf,
  defaultSelection,
  formatContext,
  groupPool,
  selectionModels,
  summarizeSync,
  toggleSelection,
} from '../src/features/model-hub/view-model.js'

function profile(id: string, overrides: Partial<HubProfile> = {}): HubProfile {
  return {
    id,
    workspaceId: 'w1',
    displayName: id,
    modelId: id,
    baseUrl: 'https://x.test/v1',
    api: 'openai-completions',
    isDefault: false,
    settings: {},
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  }
}

function provider(id: string, name: string): HubProvider {
  return {
    id,
    workspaceId: 'w1',
    kind: 'custom',
    name,
    baseUrl: 'https://x.test/v1',
    api: 'openai-completions',
    providerKind: 'openai-compatible-remote',
    modelCount: 0,
    credentialConfigured: true,
    assignedCount: 0,
    balanceSupported: false,
  }
}

describe('model hub view model', () => {
  it('prefers the catalog popular models that actually exist, and falls back to a first page', () => {
    const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect([...defaultSelection(models, ['b', 'ghost'])]).toEqual(['b'])
    expect([...defaultSelection(models, [])]).toEqual(['a', 'b', 'c'])
  })

  it('toggles and projects selections in catalog order', () => {
    const models = [{ id: 'a' }, { id: 'b' }]
    let selected = defaultSelection(models, ['a'])
    selected = toggleSelection(selected, 'b')
    expect([...selected]).toEqual(['a', 'b'])
    selected = toggleSelection(selected, 'a')
    expect(selectionModels(models, selected)).toEqual([{ id: 'b' }])
  })

  it('never maps unclear or error to the alarming tone', () => {
    expect(capabilityTone('supported')).toBe('good')
    expect(capabilityTone('unsupported')).toBe('bad')
    expect(capabilityTone('unclear')).toBe('unknown')
    expect(capabilityTone('error')).toBe('unknown')
    expect(capabilityTone(undefined)).toBe('unknown')
  })

  it('groups the pool by provider with unassigned rows last, filtered by query', () => {
    const deepseek = provider('p1', 'DeepSeek')
    const local = provider('p2', '本地')
    const profiles = [
      profile('zeta', { providerId: 'p2', displayName: 'Zeta' }),
      profile('beta', { providerId: 'p1', displayName: 'Beta' }),
      profile('legacy-1', { displayName: 'Legacy' }),
      profile('alpha', { providerId: 'p1', displayName: 'Alpha' }),
    ]
    const groups = groupPool(profiles, [deepseek, local], '')
    expect(groups.map((group) => group.provider?.name ?? '独立')).toEqual(['DeepSeek', '本地', '独立'])
    expect(groups[0]!.profiles.map((item) => item.displayName)).toEqual(['Alpha', 'Beta'])
    expect(groupPool(profiles, [deepseek, local], 'beta').map((group) => group.profiles[0]?.displayName)).toEqual(['Beta'])
    // Paste-the-id search works on model ids, not just display names.
    expect(groupPool(profiles, [deepseek, local], 'legacy-1').flatMap((group) => group.profiles).map((item) => item.id)).toEqual(['legacy-1'])
  })

  it('hides unusable context numbers and formats thousands', () => {
    expect(contextOf(profile('x', { settings: { contextWindow: 512 } }))).toBeUndefined()
    expect(contextOf(profile('x', { settings: { contextWindow: 32_768 } }))).toBe(32_768)
    expect(formatContext(undefined)).toBe('—')
    expect(formatContext(32_768)).toBe('32K')
  })

  it('summarizes sync without double counting changed rows', () => {
    const summary = summarizeSync({ added: [1, 2], removed: [], changed: [3], unchanged: 10 })
    expect(summary).toEqual({ added: 2, removed: 0, changed: 1, untouched: 9 })
  })
})
