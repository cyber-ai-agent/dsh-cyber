import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStore } from '@dsh-cyber/persistence'
import { ModelInteractionService } from '../src/services/model-interaction-service.js'

const roots: string[] = []
const stores: SqliteStore[] = []
const now = '2026-09-07T12:00:00.000Z'
const range = { from: '2026-08-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }
afterEach(async () => { for (const s of stores.splice(0)) await s.close(); for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cyber-stats-regression-')); roots.push(root)
  const store = await SqliteStore.open(join(root, 'test.db'), { clock: () => now }); stores.push(store)
  const workspaceId = store.createWorkspace({ name: '统计回归' }).id
  const service = new ModelInteractionService(store)
  const record = (provider: string, durationMs = 100) => service.recordTurn({ workspaceId, modelId: 'same-model', provider, status: 'success', prompt: 'test', durationMs, toolCallCount: 4, tokenUsage: { prompt: 100, completion: 10, total: 110, cachedPrompt: 25 } })
  return { store, workspaceId, service, record }
}
describe('PR 190 data regressions', () => {
  it('counts the actual tool_call_count column', async () => {
    const { service, workspaceId, record } = await setup(); record('A')
    const r = service.aggregateStats(workspaceId, { groupBy: 'all', ...range })
    expect(r.summary.totalToolCalls).toBe(4); expect(r.items[0]?.toolCalls).toBe(4)
  })
  it('keeps the full provider menu when one provider is selected', async () => {
    const { service, workspaceId, record } = await setup(); record('A'); record('B')
    const r = service.aggregateStats(workspaceId, { groupBy: 'provider', providerId: 'A', ...range })
    expect(r.distinctProviders).toEqual(['A', 'B']); expect(r.summary.totalRequests).toBe(1)
  })
  it('persists and sums actually reported cached tokens', async () => {
    const { service, workspaceId, record } = await setup(); record('A')
    const r = service.aggregateStats(workspaceId, { groupBy: 'all', ...range })
    expect(r.summary.tokensCached).toBe(25); expect(r.items[0]).toMatchObject({ tokensCached: 25, hasCacheData: true })
  })
  it('rejects reversed date bounds rather than claiming zero usage', async () => {
    const { service, workspaceId } = await setup()
    expect(() => service.aggregateStats(workspaceId, { groupBy: 'all', from: range.to, to: range.from })).toThrow()
  })
})

describe('stable connection attribution and truthful aggregates', () => {
  it('filters by the exact routed connection, survives rename/deletion, and keeps legacy unknown', async () => {
    const { store, service, workspaceId, record } = await setup()
    const provider = store.saveModelProvider({ workspaceId, name: '服务商名称', kind: 'custom', baseUrl: 'https://provider.example/v1', api: 'openai-completions', providerKind: 'openai-compatible-remote' })
    const profile = store.saveModelProfile({ workspaceId, providerId: provider.id, displayName: '与服务商不同的模型名称', modelId: 'same-model', baseUrl: provider.baseUrl, api: provider.api, providerKind: provider.providerKind })
    const log = service.recordTurn({ workspaceId, modelProfileId: profile.id, modelId: profile.modelId, provider: profile.displayName, prompt: 'test', status: 'success', durationMs: 80, toolCallCount: 2 })
    expect(log).toMatchObject({ providerId: provider.id, providerName: provider.name })
    record(profile.displayName) // old ambiguous log is never silently assigned to this connection
    let r = service.aggregateStats(workspaceId, { groupBy: 'provider', providerId: `provider:${provider.id}`, ...range })
    expect(r.summary.totalRequests).toBe(1)
    expect(r.providers).toEqual(expect.arrayContaining([{ id: `legacy:${profile.displayName}`, name: profile.displayName, legacy: true }]))
    store.saveModelProvider({ ...provider, name: '改名后的服务商' })
    r = service.aggregateStats(workspaceId, { groupBy: 'provider', providerId: `provider:${provider.id}`, ...range })
    expect(r.providers?.find((p) => !p.legacy)?.name).toBe('改名后的服务商')
    store.database.prepare('DELETE FROM model_profiles WHERE id = ?').run(profile.id)
    store.database.prepare('DELETE FROM model_providers WHERE id = ?').run(provider.id)
    r = service.aggregateStats(workspaceId, { groupBy: 'provider', providerId: `provider:${provider.id}`, ...range })
    expect(r.summary.totalRequests).toBe(1); expect(r.providers?.find((p) => !p.legacy)?.name).toBe(provider.name)
  })
  it('does not collapse same-named connections or take a model name from another provider', async () => {
    const { store, service, workspaceId } = await setup()
    const ids: string[] = []
    for (const n of [1, 2]) {
      const p = store.saveModelProvider({ workspaceId, name: '同名服务商', kind: 'custom', baseUrl: `https://p${n}.example/v1`, api: 'openai-completions', providerKind: 'openai-compatible-remote' }); ids.push(p.id)
      const profile = store.saveModelProfile({ workspaceId, providerId: p.id, displayName: `昵称${n}`, modelId: 'shared-model', baseUrl: p.baseUrl, api: p.api, providerKind: p.providerKind })
      service.recordTurn({ workspaceId, modelProfileId: profile.id, modelId: profile.modelId, provider: profile.displayName, prompt: '', status: 'success', durationMs: n * 100 })
    }
    const r = service.aggregateStats(workspaceId, { groupBy: 'provider', providerId: `provider:${ids[0]}`, ...range })
    expect(r.summary.totalRequests).toBe(1); expect(r.providers?.filter((p) => !p.legacy)).toHaveLength(2)
    expect(r.items[0]?.name).toBe('shared-model'); expect(JSON.stringify(r.items)).not.toContain('昵称2')
  })
  it('distinguishes absent cache, reported zero, and mixed known/unknown records', async () => {
    const { service, workspaceId, record } = await setup()
    const input = { workspaceId, modelId: 'unknown-cache', provider: 'P', status: 'success' as const, prompt: '', durationMs: 10 }
    service.recordTurn(input)
    expect(service.aggregateStats(workspaceId, { groupBy: 'all', ...range }).summary.tokensCached).toBeUndefined()
    service.recordTurn({ ...input, tokenUsage: { prompt: 10, completion: 2, total: 12, cachedPrompt: 0 } })
    expect(service.aggregateStats(workspaceId, { groupBy: 'all', ...range }).summary.tokensCached).toBe(0)
    record('P')
    expect(service.aggregateStats(workspaceId, { groupBy: 'all', ...range }).summary.tokensCached).toBe(25)
  })
  it('scopes counts, provider choices and labels to the requested workspace', async () => {
    const { store, service, workspaceId, record } = await setup(); record('local')
    const other = store.createWorkspace({ name: 'other' }).id
    service.recordTurn({ workspaceId: other, modelId: 'private-model', provider: 'private-provider', prompt: '', status: 'success', durationMs: 1 })
    const r = service.aggregateStats(workspaceId, { groupBy: 'all', ...range })
    expect(r.summary.totalRequests).toBe(1); expect(JSON.stringify(r)).not.toContain('private-')
  })
  it('uses SQL for a large log set and the store clock for the default window', async () => {
    const { store, service, workspaceId } = await setup()
    store.database.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
      INSERT INTO model_interaction_logs(id, workspace_id, source, model_id, provider, status, prompt_message_count, prompt_char_count, duration_ms, tool_call_count, created_at)
      SELECT 'bulk-' || i, ?, 'turn', 'model', 'bulk', 'success', 1, 1, i, 3, ? FROM n`).run(workspaceId, now)
    const r = service.aggregateStats(workspaceId, { groupBy: 'all' })
    expect(r.summary).toMatchObject({ totalRequests: 5000, totalToolCalls: 15000, avgLatencyMs: 2501 })
    expect(r.items).toHaveLength(1)
  })
})


it('keeps the captured provider when a model is reassigned while the request runs', async () => {
  const { store, service, workspaceId } = await setup()
  const a = store.saveModelProvider({ workspaceId, name: '原服务商', kind: 'custom', baseUrl: 'https://a.example/v1', api: 'openai-completions', providerKind: 'openai-compatible-remote' })
  const b = store.saveModelProvider({ ...a, id: 'other-connection', name: '新服务商' })
  const profile = store.saveModelProfile({ workspaceId, providerId: a.id, displayName: '模型', modelId: 'model', baseUrl: a.baseUrl, api: a.api, providerKind: a.providerKind })
  const providerSnapshot = service.captureProvider(workspaceId, profile.id)
  store.saveModelProfile({ ...profile, providerId: b.id })
  const log = service.recordTurn({ workspaceId, modelProfileId: profile.id, providerSnapshot, modelId: profile.modelId, provider: profile.displayName, prompt: '', status: 'success', durationMs: 100 })
  expect(log.providerId).toBe(a.id)
  expect(service.aggregateStats(workspaceId, { groupBy: 'provider', providerId: `provider:${b.id}`, ...range }).summary.totalRequests).toBe(0)
})
