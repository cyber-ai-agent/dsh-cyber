import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { SqliteStore } from '../src/index.js'

it('migrates v48 logs without inventing provider IDs/cache and restores new fields after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyber-stats-migration-')); const file = join(root, 'state.db')
  let store: SqliteStore | undefined
  try {
    store = await SqliteStore.open(file)
    const workspaceId = store.createWorkspace({ name: 'existing data' }).id
    const log = store.recordModelInteraction({ workspaceId, modelId: 'model', provider: 'old-name', source: 'turn', status: 'success', promptMessageCount: 1, promptCharCount: 5, tokensPrompt: 12, tokensCompletion: 3, toolCallCount: 2, durationMs: 20 })
    await store.close(); store = undefined
    const legacy = new DatabaseSync(file)
    legacy.exec(`DROP INDEX model_interaction_stats_provider_idx;
      ALTER TABLE model_interaction_logs DROP COLUMN provider_id;
      ALTER TABLE model_interaction_logs DROP COLUMN provider_name;
      ALTER TABLE model_interaction_logs DROP COLUMN tokens_cached;
      DELETE FROM schema_migrations WHERE version IN (49, 50, 51); PRAGMA user_version = 48;`)
    legacy.close()
    store = await SqliteStore.open(file)
    expect(store.doctor().ok).toBe(true)
    expect(store.getModelInteraction(log.id)).toEqual(log)
    expect(store.getModelInteraction(log.id)?.tokensCached).toBeUndefined()
    expect((await readdir(root)).some((p) => p.includes('pre-migration-v48'))).toBe(true)
    const added = store.recordModelInteraction({ workspaceId, modelId: 'model', provider: 'new', source: 'turn', status: 'success', promptMessageCount: 1, promptCharCount: 5, tokensPrompt: 12, tokensCompletion: 3, tokensCached: 0, durationMs: 20 })
    await store.close(); store = await SqliteStore.open(file)
    expect(store.getModelInteraction(added.id)?.tokensCached).toBe(0)
    expect(store.listModelInteractions(workspaceId, { page: 1, pageSize: 100 }).total).toBe(2)
  } finally { await store?.close(); await rm(root, { recursive: true, force: true }) }
})
