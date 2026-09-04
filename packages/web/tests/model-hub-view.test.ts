import { describe, expect, it } from 'vitest'

import type { HubProfile, HubProvider } from '../src/features/model-hub/api.js'

import {
  declaredCapabilities,
  defaultSelection,
  filterPool,
  formatContext,
  poolFilters,
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

  it('builds the left rail as all + providers (+ legacy only when orphans exist)', () => {
    const deepseek = provider('p1', 'DeepSeek')
    const local = provider('p2', '本地')
    const rows = [profile('a', { providerId: 'p1' }), profile('b', { providerId: 'p1' }), profile('c', { providerId: 'p2' })]
    expect(poolFilters([deepseek, local], rows)).toEqual([
      { key: 'all', count: 3 },
      { key: 'p1', count: 2 },
      { key: 'p2', count: 1 },
    ])
    const withOrphan = [...rows, profile('orphan')]
    const filters = poolFilters([deepseek, local], withOrphan)
    expect(filters[filters.length - 1]).toEqual({ key: 'legacy', count: 1 })
  })

  it('filters the pool by provider, search, and shows orphans under legacy', () => {
    const deepseek = provider('p1', 'DeepSeek')
    const rows = [
      profile('zeta', { providerId: 'p2', displayName: 'Zeta' }),
      profile('beta', { providerId: 'p1', displayName: 'Beta' }),
      profile('orphan-1'),
      profile('alpha', { providerId: 'p1', displayName: 'Alpha' }),
    ]
    expect(filterPool(rows, [deepseek], 'p1', '').map((row) => row.displayName)).toEqual(['Alpha', 'Beta'])
    // p2 is a real provider with no profiles row here: legacy only collects
    // profiles whose providerId matches no known provider, or none at all.
    expect(filterPool(rows, [deepseek], 'legacy', '').map((row) => row.id)).toEqual(['orphan-1', 'zeta'])
    expect(filterPool(rows, [deepseek], 'all', 'beta').map((row) => row.id)).toEqual(['beta'])
    expect(filterPool(rows, [deepseek], 'all', 'orphan-1').map((row) => row.id)).toEqual(['orphan-1'])
  })

  it('reads declared capabilities and drops unusable values', () => {
    const declared = profile('x', { settings: { contextWindow: 32_768, inputTypes: ['text', 'image', 'hologram'], reasoning: true } })
    expect(declaredCapabilities(declared)).toEqual({ context: 32_768, inputTypes: ['text', 'image'], reasoning: true })
    const empty = profile('y', { settings: { contextWindow: 512 } })
    expect(declaredCapabilities(empty)).toEqual({ context: undefined, inputTypes: [], reasoning: undefined })
  })

  it('formats context sizes compactly and honestly', () => {
    expect(formatContext(undefined)).toBe('—')
    expect(formatContext(32_768)).toBe('32K')
    expect(formatContext(1_048_576)).toBe('1M')
    expect(formatContext(900)).toBe('900')
  })

  it('summarizes sync without double counting changed rows', () => {
    const summary = summarizeSync({ added: [1, 2], removed: [], changed: [3], unchanged: 10 })
    expect(summary).toEqual({ added: 2, removed: 0, changed: 1, untouched: 9 })
  })
})
