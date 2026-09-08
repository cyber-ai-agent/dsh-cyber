import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { SqliteStore } from '../src/index.js'

const before = '2026-09-01T00:00:00.000Z'
const loggedAt = '2026-09-07T12:00:00.000Z'
const range = { from: before, to: '2026-09-08T00:00:00.000Z' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cyber-provider-attribution-'))
  const file = join(root, 'state.db')
  let time = before
  let store = await SqliteStore.open(file, { clock: () => time })
  cleanups.push(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const workspaceId = store.createWorkspace({ name: '归属回归' }).id
  const world = store.createWorld({ workspaceId, name: '世界', templateId: 'test' })
  store.saveBlueprint({ schemaVersion: 1, id: 'test', version: 1, worldTemplateId: 'test', displayName: '角色', role: '成员', summary: '测试', persona: '测试', requestedSkills: [], requestedCapabilities: [], createdAt: before })
  const employee = store.recruitEmployee({ workspaceId, worldId: world.id, blueprintId: 'test', blueprintVersion: 1, skillGrants: [] })
  const provider = (id: string, name = id) => store.saveModelProvider({ id, workspaceId, name, kind: 'custom', baseUrl: `https://${id}.example/v1`, api: 'openai-completions', providerKind: 'openai-compatible-remote' })
  const profile = (id: string, providerId: string, displayName = id) => store.saveModelProfile({ id, workspaceId, providerId, displayName, modelId: 'shared-model', baseUrl: `https://${providerId}.example/v1`, api: 'openai-completions', providerKind: 'openai-compatible-remote' })
  const assign = (modelProfileId: string) => store.saveModelAssignment({ workspaceId, scope: 'employee', scopeId: employee.id, modelProfileId })
  const record = (name: string, options: { providerId?: string; durationMs?: number; noEmployee?: boolean } = {}) => store.recordModelInteraction({ workspaceId, ...(options.noEmployee ? {} : { worldId: world.id, employeeId: employee.id }), source: 'turn', modelId: 'shared-model', provider: name, ...(options.providerId ? { providerId: options.providerId } : {}), status: 'success', durationMs: options.durationMs ?? 100, promptMessageCount: 1, promptCharCount: 5, tokensPrompt: 12, tokensCompletion: 3, toolCallCount: 2 })
  return {
    get store() { return store }, workspaceId, employee, provider, profile, assign, record,
    time: (next: string) => { time = next },
    async migrate() {
      await store.close()
      const db = new DatabaseSync(file)
      db.exec('DELETE FROM schema_migrations WHERE version IN (50, 51); PRAGMA user_version = 49;')
      db.close()
      store = await SqliteStore.open(file, { clock: () => time })
    },
    async reopen() { await store.close(); store = await SqliteStore.open(file, { clock: () => time }) },
  }
}

it('recovers a matching unchanged employee route without changing usage and persists it once', async () => {
  const f = await fixture(); f.provider('a'); f.profile('pa', 'a', 'nickname-a'); f.assign('pa')
  f.time(loggedAt); const row = f.record('nickname-a'); const unknown = f.record('unmatched')
  await f.migrate()
  expect(f.store.getModelInteraction(row.id)).toEqual({ ...row, providerId: 'a', providerName: 'a' })
  expect(f.store.getModelInteraction(unknown.id)).toEqual(unknown)
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: 'provider:a', ...range }).summary.totalRequests).toBe(1)
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'all', ...range }).summary.totalRequests).toBe(2)
  await f.reopen(); expect(f.store.getModelInteraction(row.id)?.providerId).toBe('a'); expect(f.store.doctor().ok).toBe(true)
})

it('does not backfill a per-turn override to the employee default just because model IDs match', async () => {
  const f = await fixture(); f.provider('a'); f.provider('b'); f.profile('pa', 'a', 'nickname-a'); f.profile('pb', 'b', 'nickname-b'); f.assign('pa')
  f.time(loggedAt); const row = f.record('nickname-b')
  await f.migrate(); expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
})

it('leaves a shared nickname/model ambiguous across connections even with an employee default', async () => {
  const f = await fixture(); f.provider('a'); f.provider('b'); f.profile('pa', 'a', 'same'); f.profile('pb', 'b', 'same'); f.assign('pa')
  f.time(loggedAt); const row = f.record('same')
  await f.migrate(); expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
})

it('does not rewrite history after a profile was moved to another provider', async () => {
  const f = await fixture(); f.provider('a'); f.provider('b'); const profile = f.profile('pa', 'a'); f.assign('pa')
  f.time(loggedAt); const row = f.record('pa')
  f.time('2026-09-08T00:00:00.000Z'); f.store.saveModelProfile({ ...profile, providerId: 'b' })
  await f.migrate(); expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
})

it('uses request start rather than completion when configuration changed during execution', async () => {
  const f = await fixture(); f.provider('a'); f.profile('pa', 'a')
  f.time('2026-09-07T11:59:59.000Z'); f.assign('pa')
  f.time(loggedAt); const row = f.record('pa', { durationMs: 2_000 })
  await f.migrate(); expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
})

it('does not reconstruct a provider name changed after the logged request', async () => {
  const f = await fixture(); const provider = f.provider('a'); f.profile('pa', 'a'); f.assign('pa')
  f.time(loggedAt); const row = f.record('pa')
  f.time('2026-09-08T00:00:00.000Z'); f.store.saveModelProvider({ ...provider, name: 'renamed' })
  await f.migrate(); expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
})

it('never overwrites captured attribution or attributes system records from an employee default', async () => {
  const f = await fixture(); f.provider('a'); f.provider('b'); f.profile('pa', 'a'); f.assign('pa')
  f.time(loggedAt); const captured = f.record('pa', { providerId: 'b' }); const system = f.record('pa', { noEmployee: true })
  await f.migrate(); expect(f.store.getModelInteraction(captured.id)).toEqual(captured); expect(f.store.getModelInteraction(system.id)).toEqual(system)
})

it('does not count one legacy name under two same-named configured providers', async () => {
  const f = await fixture(); f.provider('a', 'same'); f.provider('b', 'same'); f.time(loggedAt)
  f.record('same'); f.record('same', { providerId: 'a' }); f.record('same', { providerId: 'b' })
  for (const id of ['a', 'b']) expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: `provider:${id}`, ...range }).summary.totalRequests).toBe(1)
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'all', ...range }).summary.totalRequests).toBe(3)
})

it('does not treat another model nickname as a configured provider name', async () => {
  const f = await fixture(); f.provider('a', 'nickname-b'); f.provider('b'); f.profile('pb', 'b', 'nickname-b'); f.time(loggedAt); f.record('nickname-b')
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: 'provider:a', ...range }).summary.totalRequests).toBe(0)
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: 'legacy:nickname-b', ...range }).summary.totalRequests).toBe(1)
})

it('does not import a provider from another workspace through a legacy assignment', async () => {
  const f = await fixture(); f.provider('a'); f.profile('pa', 'a', 'shared'); f.assign('pa')
  const workspaceId = f.store.createWorkspace({ name: 'other' }).id
  const p = f.store.saveModelProvider({ workspaceId, name: 'private-provider', kind: 'custom', baseUrl: 'https://private.example/v1', api: 'openai-completions', providerKind: 'openai-compatible-remote' })
  const profile = f.store.saveModelProfile({ workspaceId, providerId: p.id, displayName: 'shared', modelId: 'shared-model', baseUrl: p.baseUrl, api: p.api, providerKind: p.providerKind })
  f.store.database.prepare('UPDATE model_assignments SET model_profile_id = ? WHERE workspace_id = ? AND scope_id = ?').run(profile.id, f.workspaceId, f.employee.id)
  f.time(loggedAt); const row = f.record('shared')
  await f.migrate(); expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
})

it('v51 attributes legacy rows logged under the connection name itself', async () => {
  const f = await fixture()
  // provider 'conn' is the connection name; the row predates profile routing
  // and stores provider='conn' (no employee profile assignment needed, even a
  // discovery probe is attributable). v50's employee-route rule cannot reach
  // it; v51's name-layer rule must.
  f.provider('conn')
  f.profile('pconn', 'conn', 'conn-display')
  f.time(loggedAt)
  const turn = f.record('conn', { noEmployee: true })
  const probe = f.store.recordModelInteraction({ workspaceId: f.workspaceId, source: 'discovery', modelId: 'shared-model', provider: 'conn', status: 'success', durationMs: 40, promptMessageCount: 0, promptCharCount: 0 })
  await f.migrate()
  expect(f.store.getModelInteraction(turn.id)).toEqual({ ...turn, providerId: 'conn', providerName: 'conn' })
  expect(f.store.getModelInteraction(probe.id)).toEqual({ ...probe, providerId: 'conn', providerName: 'conn' })
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: 'provider:conn', ...range }).summary.totalRequests).toBe(2)
  await f.reopen(); expect(f.store.doctor().ok).toBe(true)
})

it('v51 does not claim a legacy label that is any profile display name', async () => {
  const f = await fixture()
  // Another provider's profile reuses the exact name 'conn' as its nickname,
  // so a legacy row carrying 'conn' might be that nickname, not this
  // connection - leave it unclaimed rather than guess.
  f.provider('conn')
  f.provider('b'); f.profile('pb', 'b', 'conn')
  f.time(loggedAt); const row = f.record('conn', { noEmployee: true })
  await f.migrate()
  expect(f.store.getModelInteraction(row.id)?.providerId).toBeUndefined()
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: 'provider:conn', ...range }).summary.totalRequests).toBe(0)
  expect(f.store.aggregateModelStats(f.workspaceId, { groupBy: 'provider', providerId: 'legacy:conn', ...range }).summary.totalRequests).toBe(1)
})
