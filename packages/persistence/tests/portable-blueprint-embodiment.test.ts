import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []
const roots: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('portable Blueprint Embodiment', () => {
  it('persists semantic Embodiment and allows the Blueprint to be instantiated in another world template', async () => {
    const { store, workspaceId } = await setup()
    const company = store.createWorld({
      workspaceId,
      name: '赛博公司',
      templateId: 'cyber-company',
    })
    const tavern = store.createWorld({
      workspaceId,
      name: '月下酒馆',
      templateId: 'tavern',
    })

    const portable = blueprint('portable-cat', {
      roleTags: ['companion', 'observer'],
      preferredZoneTags: ['public'],
      preferredFacilityCapabilities: ['observe'],
      allowedZoneTags: ['public', 'rest', 'meeting'],
      homeSlotTags: ['rest'],
      ambientBehaviors: ['observe-room'],
      actorRigId: 'creature.cat',
      socialPolicy: {
        canInitiateConversation: true,
        cooldownSeconds: 900,
        maxDailyConversations: 4,
      },
    })

    store.saveBlueprint(portable)
    expect(store.getBlueprint(portable.id, portable.version)).toEqual(portable)

    const companyCharacter = store.recruitEmployee({
      workspaceId,
      worldId: company.id,
      blueprintId: portable.id,
      blueprintVersion: portable.version,
    })
    const tavernCharacter = store.recruitEmployee({
      workspaceId,
      worldId: tavern.id,
      blueprintId: portable.id,
      blueprintVersion: portable.version,
    })

    expect(companyCharacter.blueprintId).toBe(portable.id)
    expect(tavernCharacter.blueprintId).toBe(portable.id)
    expect(store.getBlueprint(portable.id, portable.version)?.embodiment).toEqual(portable.embodiment)
  })

  it('keeps legacy Blueprints without Embodiment restricted to their original world template', async () => {
    const { store, workspaceId } = await setup()
    const tavern = store.createWorld({
      workspaceId,
      name: '月下酒馆',
      templateId: 'tavern',
    })
    const legacy = blueprint('legacy-secretary')
    store.saveBlueprint(legacy)

    expect(() => store.recruitEmployee({
      workspaceId,
      worldId: tavern.id,
      blueprintId: legacy.id,
      blueprintVersion: legacy.version,
    })).toThrow('belongs to cyber-company')
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-portable-blueprint-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  return { store, workspaceId: workspace.id }
}

function blueprint(
  id: string,
  embodiment?: NonNullable<EmployeeBlueprint['embodiment']>,
): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: id === 'portable-cat' ? '团子' : '旧秘书',
    role: id === 'portable-cat' ? '陪伴小猫' : '行政秘书',
    summary: id === 'portable-cat' ? '一只会观察环境的陪伴小猫。' : '旧版岗位模板。',
    persona: id === 'portable-cat' ? '你是团子，一只陪伴小猫。' : '你是旧版秘书。',
    requestedSkills: [],
    requestedCapabilities: [],
    ...(embodiment === undefined ? {} : { embodiment }),
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}
