import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'
import { characterBehaviorProfileToJson } from '@dsh-cyber/world-simulation'

import { resolveConfiguredCharacterBehavior } from '../src/services/character-behavior-resolver.js'

const stores: SqliteStore[] = []
const roots: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('character behavior resolver', () => {
  it('uses Blueprint Embodiment by default and lets an explicit Profile override it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-behavior-resolver-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const world = store.createWorld({
      workspaceId: workspace.id,
      name: '可移植世界',
      templateId: 'personal-world',
    })
    const blueprint = portableBlueprint()
    store.saveBlueprint(blueprint)
    const character = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
    })

    expect(resolveConfiguredCharacterBehavior(store, character)).toMatchObject({
      id: 'portable-companion@1',
      roleTags: ['companion'],
      preferredZoneTags: ['public'],
      homeSlotTags: ['rest'],
    })

    const current = store.getEmployeeProfile(character.id)!
    store.reviseEmployeeProfile({
      employeeId: character.id,
      background: current.background,
      personalityTraits: current.personalityTraits,
      appearance: {
        ...current.appearance,
        worldBehaviorProfile: characterBehaviorProfileToJson({
          id: 'user.override',
          roleTags: ['research'],
          preferredZoneTags: ['research'],
          preferredFacilityCapabilities: ['inspect'],
          allowedZoneTags: ['research', 'meeting', 'public'],
          homeSlotTags: ['research', 'work'],
          ambientBehaviors: ['inspect-lab'],
          socialPolicy: {
            canInitiateConversation: false,
            cooldownSeconds: 1_800,
            maxDailyConversations: 0,
          },
        }),
      },
      reason: '用户显式覆盖具身行为',
    })

    expect(resolveConfiguredCharacterBehavior(store, character)).toMatchObject({
      id: 'user.override',
      roleTags: ['research'],
      preferredZoneTags: ['research'],
    })
  })
})

function portableBlueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'portable-companion',
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: '团子',
    role: '陪伴角色',
    summary: '具备可移植世界语义的陪伴角色。',
    persona: '你是团子，保持当前用户定义的身份。',
    requestedSkills: [],
    requestedCapabilities: [],
    embodiment: {
      roleTags: ['companion'],
      preferredZoneTags: ['public'],
      preferredFacilityCapabilities: [],
      allowedZoneTags: ['public', 'rest', 'meeting'],
      homeSlotTags: ['rest'],
      ambientBehaviors: ['observe-room'],
      socialPolicy: {
        canInitiateConversation: true,
        cooldownSeconds: 900,
        maxDailyConversations: 4,
      },
    },
    createdAt: '2026-08-23T00:00:00.000Z',
  }
}
