import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalPackageRuntime, PackageManager } from '@dsh-cyber/package-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CreativeWorkshopService } from '../src/services/creative-workshop-service.js'
import { KeyedMutex } from '../src/services/keyed-mutex.js'

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const HOSTILE_IDS: [label: string, id: string][] = [
  ['parent traversal', '..'],
  ['current directory', '.'],
  ['nested traversal', '../../etc/passwd'],
  ['absolute path', '/etc/passwd'],
  ['windows absolute path', 'C:\\Windows\\system32'],
  ['raw separator', 'workshop/passwd'],
  ['backslash separator', 'workshop\\passwd'],
  ['encoded separator', '..%2F..%2Fetc'],
  ['encoded separator lowercase', 'workshop%2fpasswd'],
  ['double encoded traversal', '%252e%252e%252fetc'],
  ['very long name', `workshop.${'a'.repeat(4_000)}`],
  ['unicode', '工坊项目'],
  ['unicode traversal', '..\uFF0Fetc'],
  ['lone surrogate', 'workshop.\uD800'],
  ['embedded nul', 'workshop.\0.passwd'],
  ['leading dot', '.hidden'],
  ['empty', ''],
]

describe('workshop project path containment', () => {
  it('keeps the on-disk layout of a well-formed project id', async () => {
    const { root, workshop, workspaceId } = await setup()
    const project = await workshop.create(workspaceId, createInput())

    const projectFile = join(root, 'workshop', 'projects', project.id, 'project.json')
    expect((await stat(projectFile)).isFile()).toBe(true)
    const { worldLinked: _derived, ...storedProject } = project
    expect(JSON.parse(await readFile(projectFile, 'utf8'))).toEqual(storedProject)
    expect(await workshop.readProject(workspaceId, project.id)).toEqual(project)
  })

  for (const [label, id] of HOSTILE_IDS) {
    it(`refuses a project id with ${label}`, async () => {
      const { workshop, workspaceId } = await setup()
      await expect(workshop.readProject(workspaceId, id)).rejects.toThrow(/Workshop path/)
      await expect(workshop.mutateProject(workspaceId, id, (project) => project)).rejects.toThrow(/Workshop path/)
    })
  }

  it('skips unusable directory entries instead of failing the whole listing', async () => {
    const { root, workshop, workspaceId } = await setup()
    const project = await workshop.create(workspaceId, createInput())
    await mkdir(join(root, 'workshop', 'projects', '.stray'), { recursive: true })
    await writeFile(join(root, 'workshop', 'projects', '工坊'), 'not a project', 'utf8')

    expect((await workshop.list(workspaceId)).map((item) => item.id)).toEqual([project.id])
  })
})

describe('workshop project write serialization', () => {
  it('serializes concurrent archive/restore style writes on one project', async () => {
    const { root, workshop, workspaceId } = await setup()
    const project = await workshop.create(workspaceId, createInput())
    const projectFile = join(root, 'workshop', 'projects', project.id, 'project.json')

    // Two overlapping read-modify-write flows, each touching a different field —
    // exactly the shape of archive (mark) and restore (clear) hitting one project.
    const [archived, restored] = await Promise.all([
      workshop.mutateProject(workspaceId, project.id, async (current) => {
        await delay(20)
        return { ...current, lore: `${current.lore}[archived]`, updatedAt: '2026-01-01T00:00:00.000Z' }
      }),
      workshop.mutateProject(workspaceId, project.id, async (current) => {
        await delay(5)
        return { ...current, scenario: `${current.scenario}[restored]`, updatedAt: '2026-01-02T00:00:00.000Z' }
      }),
    ])

    const stored = await workshop.readProject(workspaceId, project.id)
    const { worldLinked: _derived, ...storedProject } = stored
    expect(JSON.parse(await readFile(projectFile, 'utf8'))).toEqual(storedProject)
    // Neither update was lost: the second flow read what the first one wrote.
    expect(stored.lore).toContain('[archived]')
    expect(stored.scenario).toContain('[restored]')
    expect([archived.updatedAt, restored.updatedAt]).toContain(stored.updatedAt)
    expect(stored.id).toBe(project.id)
    expect(stored.worldId).toBe(project.worldId)
  })

  it('keeps writes to different projects independent', async () => {
    const { workshop, workspaceId } = await setup()
    const first = await workshop.create(workspaceId, createInput('第一世界'))
    const second = await workshop.create(workspaceId, createInput('第二世界'))

    await Promise.all([
      workshop.mutateProject(workspaceId, first.id, (current) => ({ ...current, lore: 'first' })),
      workshop.mutateProject(workspaceId, second.id, (current) => ({ ...current, lore: 'second' })),
    ])

    expect((await workshop.readProject(workspaceId, first.id)).lore).toBe('first')
    expect((await workshop.readProject(workspaceId, second.id)).lore).toBe('second')
  })
})

describe('KeyedMutex', () => {
  it('runs tasks for one key strictly one at a time', async () => {
    const mutex = new KeyedMutex()
    const events: string[] = []
    await Promise.all([1, 2, 3].map((index) => mutex.run('key', async () => {
      events.push(`enter-${index}`)
      await delay(5)
      events.push(`exit-${index}`)
    })))

    expect(events).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2', 'enter-3', 'exit-3'])
  })

  it('lets different keys overlap and survives a failing task', async () => {
    const mutex = new KeyedMutex()
    let running = 0
    let peak = 0
    await Promise.all(['a', 'b'].map((key) => mutex.run(key, async () => {
      running += 1
      peak = Math.max(peak, running)
      await delay(10)
      running -= 1
    })))
    expect(peak).toBe(2)

    await expect(mutex.run('a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(mutex.run('a', async () => 'ok')).resolves.toBe('ok')
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-hardening-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const manager = new PackageManager({
    store,
    runtime: new LocalPackageRuntime(join(root, 'packages')),
  })
  return {
    root,
    store,
    workspaceId: workspace.id,
    workshop: new CreativeWorkshopService(store, manager),
  }
}

function createInput(displayName = '短剧工作室') {
  return {
    displayName,
    baseTemplateId: 'personal-world',
    lore: '一支负责短剧增长与制作的数字团队。',
    scenario: '持续分析内容表现并协作交付。',
    roles: [{
      id: 'growth-operator',
      displayName: '阿策',
      role: '短剧投流专家',
      summary: '负责投放分析与增长策略。',
      persona: '基于事实数据工作，重要外部操作需要明确授权。',
      embodiment: {
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
      },
      requestedSkillIds: [],
    }],
  }
}
