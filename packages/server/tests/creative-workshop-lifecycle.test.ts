import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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

describe('CreativeWorkshopService project archive', () => {
  it('loads a project written by an older build without a status as active', async () => {
    const { root, workshop, workspaceId } = await setup()
    await writeLegacyProject(root, workspaceId, 'workshop.legacy.0001')

    const [project] = await workshop.list(workspaceId)
    expect(project?.id).toBe('workshop.legacy.0001')
    expect(project?.status).toBe('active')
    expect(project?.archivedAt).toBeUndefined()
    // A legacy file has no updatedAt; it falls back to createdAt instead of failing.
    expect(project?.updatedAt).toBe('2025-01-01T00:00:00.000Z')
    expect((await workshop.readProject(workspaceId, 'workshop.legacy.0001')).status).toBe('active')
  })

  it('archives and restores a project and lists each view separately', async () => {
    const { store, workshop, workspaceId } = await setup()
    const project = await createProject(workshop, workspaceId, '归档演示')

    const archived = await workshop.archive(workspaceId, project.id)
    expect(archived.status).toBe('archived')
    expect(archived.archivedAt).toEqual(expect.any(String))
    expect((await workshop.list(workspaceId, 'active')).map((item) => item.id)).not.toContain(project.id)
    expect((await workshop.list(workspaceId, 'archived')).map((item) => item.id)).toEqual([project.id])
    // Archiving a project is not a world operation.
    expect(store.getWorld(project.worldId)?.status).toBe('active')

    const restored = await workshop.restore(workspaceId, project.id)
    expect(restored.status).toBe('active')
    expect(restored.archivedAt).toBeUndefined()
    expect((await workshop.list(workspaceId, 'archived'))).toEqual([])
    expect((await workshop.list(workspaceId, 'active')).map((item) => item.id)).toEqual([project.id])
  })

  it('archives a legacy status-less project without rewriting its identity', async () => {
    const { root, workshop, workspaceId } = await setup()
    await writeLegacyProject(root, workspaceId, 'workshop.legacy.0002')

    const archived = await workshop.archive(workspaceId, 'workshop.legacy.0002')
    expect(archived.status).toBe('archived')
    expect(archived.createdAt).toBe('2025-01-01T00:00:00.000Z')
    expect((await workshop.readProject(workspaceId, 'workshop.legacy.0002')).status).toBe('archived')
  })
})

describe('CreativeWorkshopService project and world decoupling', () => {
  it('permanently deletes a project and keeps its world, characters and packages', async () => {
    const { root, store, workshop, workspaceId } = await setup()
    const project = await createProject(workshop, workspaceId, '删除演示')
    const employeeCount = store.listEmployees(project.worldId).length
    expect(employeeCount).toBeGreaterThan(0)

    const deletion = await workshop.delete(workspaceId, project.id)

    expect(deletion).toEqual({ projectId: project.id, worldId: project.worldId, worldRetained: true })
    expect(await exists(join(root, 'workshop', 'projects', project.id))).toBe(false)
    expect(await workshop.list(workspaceId)).toEqual([])
    // No implicit cascade: the world and everything inside it survives.
    expect(store.getWorld(project.worldId)).toBeDefined()
    expect(store.listEmployees(project.worldId)).toHaveLength(employeeCount)
    expect(store.listWorldPackageInstances(project.worldId, 'active')).toHaveLength(1)
    expect(store.getActivePackage(workspaceId, project.generatedPackageIds[0]!)).toBeDefined()
  })

  it('keeps the project as a detached record when its world is deleted', async () => {
    const { root, store, workshop, workspaceId } = await setup()
    const project = await createProject(workshop, workspaceId, '脱钩演示')
    expect(project.worldLinked).toBe(true)

    store.rollbackWorldCreation(project.worldId, 'world-deleted-by-owner')
    expect(store.getWorld(project.worldId)).toBeUndefined()

    // No implicit cascade in the other direction either: the project file stays.
    expect(await exists(join(root, 'workshop', 'projects', project.id, 'project.json'))).toBe(true)
    const [detached] = await workshop.list(workspaceId)
    expect(detached?.id).toBe(project.id)
    expect(detached?.worldLinked).toBe(false)
    expect(detached?.status).toBe('active')
    expect((await workshop.readProject(workspaceId, project.id)).worldLinked).toBe(false)
  })

  it('still archives, restores and deletes a detached project', async () => {
    const { store, workshop, workspaceId } = await setup()
    const project = await createProject(workshop, workspaceId, '脱钩归档')
    store.rollbackWorldCreation(project.worldId, 'world-deleted-by-owner')

    expect((await workshop.archive(workspaceId, project.id)).status).toBe('archived')
    expect((await workshop.restore(workspaceId, project.id)).worldLinked).toBe(false)
    expect(await workshop.delete(workspaceId, project.id)).toMatchObject({ worldRetained: true })
  })

  it('reports a missing project instead of failing with a raw filesystem error', async () => {
    const { workshop, workspaceId } = await setup()
    await expect(workshop.readProject(workspaceId, 'workshop.absent.0001')).rejects.toMatchObject({
      kind: 'not-found',
      code: 'workshop_project_not_found',
    })
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workshop-lifecycle-'))
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

async function createProject(workshop: CreativeWorkshopService, workspaceId: string, displayName: string) {
  return workshop.create(workspaceId, {
    displayName,
    baseTemplateId: 'personal-world',
    lore: '用于生命周期测试的世界。',
    scenario: '验证项目与世界互不牵连。',
    roles: [{
      id: 'role-1',
      displayName: '阿策',
      role: '运营',
      summary: '负责日常运营。',
      persona: '以事实为准，不虚构信息。',
      embodiment: embodiment(),
      requestedSkillIds: [],
    }],
  })
}

/** A project.json exactly as an older build wrote it: no status, no updatedAt. */
async function writeLegacyProject(root: string, workspaceId: string, projectId: string): Promise<void> {
  const directory = join(root, 'workshop', 'projects', projectId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'project.json'), `${JSON.stringify({
    schemaVersion: 1,
    id: projectId,
    workspaceId,
    worldId: 'world-from-an-older-build',
    displayName: '旧版项目',
    baseTemplateId: 'personal-world',
    lore: '',
    scenario: '',
    roles: [],
    generatedPackageIds: [],
    createdAt: '2025-01-01T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function embodiment() {
  return {
    roleTags: ['operations'],
    preferredZoneTags: ['operations'],
    preferredFacilityCapabilities: ['monitoring'],
    allowedZoneTags: ['operations', 'public'],
    homeSlotTags: ['operations'],
    ambientBehaviors: ['inspect-dashboard'],
    socialPolicy: {
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    },
  }
}
