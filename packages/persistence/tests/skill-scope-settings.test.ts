import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SkillScopeSettingsRepository, SqliteStore } from '../src/index.js'

const roots: string[] = []
const stores: SqliteStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('SkillScopeSettingsRepository', () => {
  it('persists exact empty/global/world selections and clears world overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-scope-')); roots.push(root)
    const store = await SqliteStore.open(join(root, 'data.sqlite')); stores.push(store)
    const workspace = store.createWorkspace({ name: '技能范围' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '研发世界', templateId: 'personal-world' })
    const repository = new SkillScopeSettingsRepository(store.database)
    expect(repository.get(workspace.id, 'workspace', workspace.id)).toBeUndefined()
    expect(repository.save({ workspaceId: workspace.id, scope: 'workspace', scopeId: workspace.id, skillIds: [] }).skillIds).toEqual([])
    expect(repository.save({ workspaceId: workspace.id, scope: 'world', scopeId: world.id, skillIds: ['testing', 'coding'] }).skillIds).toEqual(['coding', 'testing'])
    expect(repository.list(workspace.id)).toHaveLength(2)
    expect(repository.clear(workspace.id, 'world', world.id)).toBe(true)
    expect(repository.get(workspace.id, 'world', world.id)).toBeUndefined()
  })
})
