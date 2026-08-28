import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore } from '@dsh-cyber/persistence'
import { CreativeWorkshopDraftService } from '../src/services/creative-workshop-draft-service.js'

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('CreativeWorkshopDraftService', () => {
  it('persists and restores one strict workspace draft without creating entities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-draft-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '草稿工作区' })
    const service = new CreativeWorkshopDraftService(store)
    const saved = await service.save(workspace.id, {
      schemaVersion: 1,
      world: { name: '夜航工作室', description: '', purpose: '', modelPolicy: { mode: 'inherit' } },
      characters: [
        { tempId: 'draft-pm', name: '林夕', requestedSkills: ['product-planning'] },
        { tempId: 'draft-dev', name: '阿澈', modelPolicy: { mode: 'recommend', requiredCapabilities: ['text', 'tools'], reason: '负责开发' } },
      ],
    })
    expect(saved.characters).toHaveLength(2)
    expect(store.listWorlds(workspace.id)).toHaveLength(0)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(reopened)
    const restartedService = new CreativeWorkshopDraftService(reopened)
    expect(await restartedService.get(workspace.id)).toEqual(saved)
    expect(await restartedService.delete(workspace.id)).toBe(true)
    expect(await restartedService.get(workspace.id)).toBeUndefined()
  })

  it('rejects grants, internal identities, control characters, and duplicate draft ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-draft-invalid-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '安全草稿工作区' })
    const service = new CreativeWorkshopDraftService(store)
    await expect(service.save(workspace.id, { schemaVersion: 1, world: { name: '越权世界' }, characters: [{ tempId: 'same', name: '甲', skillGrants: ['browser'] }] })).rejects.toThrow('不允许')
    await expect(service.save(workspace.id, { schemaVersion: 1, world: { name: '控制\0字符' }, characters: [{ tempId: 'same', name: '甲' }] })).rejects.toThrow()
    await expect(service.save(workspace.id, { schemaVersion: 1, world: { name: '重复世界' }, characters: [{ tempId: 'same', name: '甲' }, { tempId: 'same', name: '乙' }] })).rejects.toThrow('重复')
  })
})
