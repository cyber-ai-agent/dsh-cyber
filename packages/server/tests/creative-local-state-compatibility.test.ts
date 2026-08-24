import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalPackageRuntime, PackageManager } from '@dsh-cyber/package-runtime'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CreativeWorkshopService } from '../src/services/creative-workshop-service.js'
import { createLocalBackupBundle } from '../src/services/local-backup-service.js'

const gunzipAsync = promisify(gunzip)
const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('local-first creative state compatibility', () => {
  it('reads legacy workshop skillIds as requestedSkillIds without rebuilding the world', async () => {
    const { root, store, workspaceId, workshop } = await setup()
    const world = store.createWorld({ workspaceId, name: '旧世界', templateId: 'personal-world' })
    const projectId = 'workshop.legacy.sample'
    const projectRoot = join(root, 'workshop', 'projects', projectId)
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      id: projectId,
      workspaceId,
      worldId: world.id,
      displayName: '旧创意项目',
      baseTemplateId: 'personal-world',
      lore: '',
      scenario: '',
      roles: [{
        id: 'legacy-role',
        displayName: '旧角色',
        role: '旧岗位',
        summary: '升级前创建的角色。',
        persona: '保持历史设定。',
        embodiment: {
          roleTags: ['general'],
          preferredZoneTags: ['public'],
          preferredFacilityCapabilities: ['collaboration'],
          allowedZoneTags: ['public', 'meeting', 'rest'],
          homeSlotTags: ['public'],
          ambientBehaviors: ['observe-world'],
        },
        skillIds: ['smart-home.control'],
      }],
      generatedPackageIds: [],
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    }, null, 2))

    const restored = await workshop.readProject(workspaceId, projectId)

    expect(restored.worldId).toBe(world.id)
    expect(restored.roles[0]?.requestedSkillIds).toEqual(['smart-home.control'])
    expect('skillIds' in (restored.roles[0] as unknown as Record<string, unknown>)).toBe(false)
  })

  it('backs up workshop projects and skill actions while excluding credentials and runtime', async () => {
    const { root, store } = await setup()
    await mkdir(join(root, 'workshop', 'projects', 'project-a'), { recursive: true })
    await writeFile(join(root, 'workshop', 'projects', 'project-a', 'project.json'), '{"schemaVersion":1}\n')
    await mkdir(join(root, 'skills'), { recursive: true })
    await writeFile(join(root, 'skills', 'actions.json'), '{"version":2,"actions":[]}\n')
    await mkdir(join(root, 'integrations'), { recursive: true })
    await writeFile(join(root, 'integrations', 'connections.json'), '{"version":1,"items":[]}\n')
    await mkdir(join(root, 'credentials'), { recursive: true })
    await writeFile(join(root, 'credentials', 'secret.bin'), 'must-not-be-backed-up')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'runtime', 'candidate.bin'), 'rebuildable-runtime')

    const output = join(root, 'backups', 'local-state.dshbackup')
    await createLocalBackupBundle(root, store, { output })
    const bundle = JSON.parse((await gunzipAsync(await readFile(output))).toString('utf8')) as {
      format: string
      included: string[]
      excluded: string[]
      entries: Array<{ path: string }>
    }
    const paths = bundle.entries.map((entry) => entry.path)

    expect(bundle.format).toBe('dsh-cyber-local-backup')
    expect(bundle.included).toEqual(expect.arrayContaining(['database.sqlite', 'workshop', 'skills', 'integrations']))
    expect(paths).toContain('workshop/projects/project-a/project.json')
    expect(paths).toContain('skills/actions.json')
    expect(paths).toContain('integrations/connections.json')
    expect(paths.some((path) => path.startsWith('credentials/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('runtime/'))).toBe(false)
    expect(bundle.excluded).toEqual(expect.arrayContaining(['credentials', 'runtime']))
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-creative-local-state-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const packageManager = new PackageManager({
    store,
    runtime: new LocalPackageRuntime(join(root, 'packages')),
  })
  return {
    root,
    store,
    workspaceId: workspace.id,
    workshop: new CreativeWorkshopService(store, packageManager),
  }
}
