import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalPackageRuntime, PackageManager } from '@dsh-cyber/package-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CreativeWorkshopService } from '../src/services/creative-workshop-service.js'

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('CreativeWorkshopService', () => {
  it('compiles portable role packages while keeping requested skills ungranted', async () => {
    const { store, workshop, workspaceId } = await setup()

    const project = await workshop.create(workspaceId, {
      displayName: '短剧工作室',
      baseTemplateId: 'personal-world',
      lore: '一支负责短剧增长与制作的数字团队。',
      scenario: '持续分析内容表现并协作交付。',
      roles: [{
        id: 'growth-operator',
        displayName: '阿策',
        role: '短剧投流专家',
        summary: '负责投放分析与增长策略。',
        persona: '基于事实数据工作，重要外部操作需要明确授权。',
        embodiment: embodiment(),
        requestedSkillIds: ['smart-home.control'],
      }],
    })

    expect(project.generatedPackageIds).toHaveLength(1)
    const employee = store.listEmployees(project.worldId)[0]!
    const revision = store.getEmployeeRevision(employee.id, employee.currentRevision)!
    const blueprint = store.getBlueprint(employee.blueprintId, employee.blueprintVersion)!
    expect(blueprint.requestedSkills).toEqual(['smart-home.control'])
    expect(revision.skillGrants).toEqual([])
    expect(store.getEmployeeProfile(employee.id)?.appearance).toMatchObject({
      worldBehaviorProfile: {
        preferredZoneTags: ['operations'],
      },
    })

    const restored = await workshop.readProject(workspaceId, project.id)
    expect(restored).toEqual(project)
    expect((await workshop.list(workspaceId)).map((item) => item.id)).toContain(project.id)
  })

  it('rejects malformed role semantics before creating a world', async () => {
    const { store, workshop, workspaceId } = await setup()
    const before = store.listWorlds(workspaceId).length

    await expect(workshop.create(workspaceId, {
      displayName: '非法世界',
      baseTemplateId: 'personal-world',
      roles: [{
        id: 'bad-role',
        displayName: '坏角色',
        role: '测试',
        summary: '测试非法语义。',
        persona: 'test',
        embodiment: {
          ...embodiment(),
          roleTags: ['operations', 'operations'],
        },
        requestedSkillIds: [],
      }],
    })).rejects.toThrow()

    expect(store.listWorlds(workspaceId)).toHaveLength(before)
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const manager = new PackageManager({
    store,
    runtime: new LocalPackageRuntime(join(root, 'packages')),
  })
  return {
    store,
    workspaceId: workspace.id,
    workshop: new CreativeWorkshopService(store, manager),
  }
}

function embodiment() {
  return {
    roleTags: ['operations', 'analytics'],
    preferredZoneTags: ['operations'],
    preferredFacilityCapabilities: ['monitoring', 'analysis'],
    allowedZoneTags: ['operations', 'meeting', 'rest', 'public'],
    homeSlotTags: ['operations', 'work'],
    ambientBehaviors: ['inspect-dashboard'],
    socialPolicy: {
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    },
  }
}
