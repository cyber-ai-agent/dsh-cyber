import { createHash } from 'node:crypto'
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
    // The bundle is newline-delimited JSON: one header record, then one record
    // per file chunk, so nothing is ever held as a single unbounded string.
    const lines = (await gunzipAsync(await readFile(output))).toString('utf8').split('\n').filter(Boolean)
    const bundle = JSON.parse(lines[0]!) as {
      schemaVersion: number
      format: string
      included: string[]
      excluded: string[]
    }
    const entries = lines.slice(1).map((line) => JSON.parse(line) as {
      path: string
      byteLength: number
      sha256: string
      chunkIndex: number
      chunkCount: number
      dataBase64: string
    })
    const paths = entries.map((entry) => entry.path)

    expect(bundle.schemaVersion).toBe(2)
    // Every chunk of every file must round-trip to its declared digest.
    for (const [path, group] of groupBy(entries, (entry) => entry.path)) {
      const body = Buffer.concat(group
        .sort((left, right) => left.chunkIndex - right.chunkIndex)
        .map((entry) => Buffer.from(entry.dataBase64, 'base64')))
      expect(body.byteLength, path).toBe(group[0]!.byteLength)
      expect(createHash('sha256').update(body).digest('hex'), path).toBe(group[0]!.sha256)
    }

    expect(bundle.format).toBe('dsh-cyber-local-backup')
    expect(bundle.included).toEqual(expect.arrayContaining(['database.sqlite', 'workshop', 'skills', 'integrations']))
    expect(paths).toContain('workshop/projects/project-a/project.json')
    expect(paths).toContain('skills/actions.json')
    expect(paths).toContain('integrations/connections.json')
    expect(paths.some((path) => path.startsWith('credentials/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('runtime/'))).toBe(false)
    expect(bundle.excluded).toEqual(expect.arrayContaining(['credentials', 'runtime']))
  })
  it('splits a file larger than one chunk instead of building an unbounded string', async () => {
    const { root, store } = await setup()
    // The v1 layout base64-encoded every file into one JS string and threw
    // RangeError above roughly 400 MB of state — which also permanently blocked
    // application updates, because the backup is their mandatory precondition.
    // Nine megabytes is enough to prove the chunking without a slow test.
    const body = Buffer.alloc(9 * 1024 * 1024, 'dsh')
    await mkdir(join(root, 'packages', 'big'), { recursive: true })
    await writeFile(join(root, 'packages', 'big', 'payload.bin'), body)

    const output = join(root, 'backups', 'large-state.dshbackup')
    await createLocalBackupBundle(root, store, { output })
    const lines = (await gunzipAsync(await readFile(output))).toString('utf8').split('\n').filter(Boolean)
    const chunks = lines.slice(1)
      .map((line) => JSON.parse(line) as { path: string; chunkIndex: number; chunkCount: number; sha256: string; dataBase64: string })
      .filter((entry) => entry.path === 'packages/big/payload.bin')
      .sort((left, right) => left.chunkIndex - right.chunkIndex)

    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.chunkCount).toBe(3)
    // No single record carries the whole file, and the file still round-trips.
    for (const chunk of chunks) expect(chunk.dataBase64.length).toBeLessThan(body.byteLength)
    const restored = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.dataBase64, 'base64')))
    expect(restored.equals(body)).toBe(true)
    expect(createHash('sha256').update(restored).digest('hex')).toBe(chunks[0]!.sha256)
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

function groupBy<TItem, TKey>(items: readonly TItem[], key: (item: TItem) => TKey): Map<TKey, TItem[]> {
  const groups = new Map<TKey, TItem[]>()
  for (const item of items) {
    const group = groups.get(key(item))
    if (group === undefined) groups.set(key(item), [item])
    else group.push(item)
  }
  return groups
}
