import { mkdtemp, readdir, rm } from 'node:fs/promises'
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

describe('CreativeWorkshopService compensation', () => {
  it('removes half-built worlds, blueprints, active packages and project files after a late build failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-compensation-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地工作区' })
    const manager = new PackageManager({
      store,
      runtime: new LocalPackageRuntime(join(root, 'packages')),
    })
    const workshop = new CreativeWorkshopService(store, manager)

    // Inject failure at a stable construction boundary rather than an
    // implementation detail such as profile materialization. By the second
    // recruit all generated packages are active and the world already exists,
    // so this still exercises full composite compensation while allowing the
    // Blueprint/Profile architecture to evolve independently.
    const originalRecruit = store.recruitEmployee.bind(store)
    let recruitCalls = 0
    let injected = false
    Object.defineProperty(store, 'recruitEmployee', {
      configurable: true,
      value: ((input: Parameters<SqliteStore['recruitEmployee']>[0]) => {
        recruitCalls += 1
        if (recruitCalls === 2) {
          injected = true
          throw new Error('simulated late Workshop recruit failure')
        }
        return originalRecruit(input)
      }) satisfies SqliteStore['recruitEmployee'],
    })

    await expect(workshop.create(workspace.id, {
      displayName: '会失败的创意世界',
      baseTemplateId: 'personal-world',
      lore: '用于验证组合事务补偿。',
      scenario: '所有角色包已安装且第一个角色已创建后，第二个角色创建失败。',
      roles: [
        role('planner', '阿策', '内容策划'),
        role('editor', '阿剪', '视频剪辑师'),
      ],
    })).rejects.toThrow('simulated late Workshop recruit failure')

    expect(injected).toBe(true)
    expect(recruitCalls).toBe(2)
    expect(store.listWorlds(workspace.id)).toEqual([])
    expect(store.listBlueprints()).toEqual([])
    expect(store.listInstalledPackages(workspace.id).filter((item) => item.status === 'active')).toEqual([])

    const packageTransactions = store.listPackageInstallTransactions(workspace.id)
    expect(packageTransactions).toHaveLength(2)
    expect(packageTransactions.every((item) => item.status === 'rolled-back')).toBe(true)
    expect(packageTransactions.every((item) => item.errorCode === 'creative-workshop-build-failed')).toBe(true)

    expect(await workshop.list(workspace.id)).toEqual([])
    expect(await directoryEntries(join(root, 'workshop', 'projects'))).toEqual([])
    expect(await directoryEntries(join(root, 'worlds'))).toEqual([])

    const activePointers = await directoryEntries(join(root, 'packages', 'active'))
    expect(activePointers).toEqual([])
    expect(store.listDomainEvents(workspace.id).some((event) =>
      event.type === 'world.creation.rolled-back'
      && event.payload.reason === 'creative-workshop-build-failed',
    )).toBe(true)
  })
})

function role(id: string, displayName: string, identity: string) {
  return {
    id,
    displayName,
    role: identity,
    summary: `${identity}，负责真实工作流中的独立交付。`,
    persona: `你是${displayName}，保持自己的身份与事实边界。`,
    embodiment: {
      roleTags: ['creative', 'content'],
      preferredZoneTags: ['creative'],
      preferredFacilityCapabilities: ['create', 'review'],
      allowedZoneTags: ['creative', 'meeting', 'rest', 'public'],
      homeSlotTags: ['creative', 'work'],
      ambientBehaviors: ['review-creative-board'],
      socialPolicy: {
        canInitiateConversation: false,
        cooldownSeconds: 1_800,
        maxDailyConversations: 0,
      },
    },
    requestedSkillIds: [],
  }
}

async function directoryEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
