import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore } from '@dsh-cyber/persistence'

import { createLocalBackupBundle, restoreLocalBackupBundle } from '../src/services/local-backup-service.js'

const gunzipAsync = promisify(gunzip)
const gzipAsync = promisify(gzip)

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed by the test.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seededRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restore-source-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '我的世界', templateId: 'personal-world' })
  await mkdir(join(root, 'worlds', world.id, 'files'), { recursive: true })
  await writeFile(join(root, 'worlds', world.id, 'files', 'note.md'), '# 保留这份笔记\n')
  await mkdir(join(root, 'skills'), { recursive: true })
  await writeFile(join(root, 'skills', 'actions.json'), '{"actions":[]}')
  await mkdir(join(root, 'credentials'), { recursive: true })
  await writeFile(join(root, 'credentials', 'secret.txt'), 'must-not-travel')
  return { root, store, workspace, world }
}

async function emptyRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('local backup restore', () => {
  it('round-trips a state root a backup can actually recover', async () => {
    const { root, store, world } = await seededRoot()
    const bundle = join(root, 'backups', 'round-trip.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const target = await emptyRoot('dsh-restore-target-')
    const result = await restoreLocalBackupBundle(target, bundle)

    expect(result.included).toEqual(expect.arrayContaining(['database.sqlite', 'worlds', 'skills']))
    expect(result.files).toBeGreaterThan(0)
    expect(await readFile(join(target, 'worlds', world.id, 'files', 'note.md'), 'utf8')).toContain('保留这份笔记')
    expect(await readFile(join(target, 'skills', 'actions.json'), 'utf8')).toBe('{"actions":[]}')

    // The restored database is a working database, not just bytes on disk.
    const restored = await SqliteStore.open(join(target, 'data', 'dsh-cyber.sqlite'))
    stores.push(restored)
    expect(restored.getWorld(world.id)?.name).toBe('我的世界')
  })

  it('never carries credentials across a restore, because they never entered the bundle', async () => {
    const { root, store } = await seededRoot()
    const bundle = join(root, 'backups', 'no-credentials.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const target = await emptyRoot('dsh-restore-nocred-')
    const result = await restoreLocalBackupBundle(target, bundle)
    expect(result.included).not.toContain('credentials')
    await expect(readFile(join(target, 'credentials', 'secret.txt'), 'utf8')).rejects.toThrow()
  })

  it('refuses to overwrite a state root that already holds a database', async () => {
    const { root, store } = await seededRoot()
    const bundle = join(root, 'backups', 'guard.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const target = await emptyRoot('dsh-restore-guard-')
    await mkdir(join(target, 'data'), { recursive: true })
    await writeFile(join(target, 'data', 'dsh-cyber.sqlite'), 'existing')

    await expect(restoreLocalBackupBundle(target, bundle)).rejects.toThrow(/already holds a database/)
    // The existing database is untouched by the refusal.
    expect(await readFile(join(target, 'data', 'dsh-cyber.sqlite'), 'utf8')).toBe('existing')
    await expect(restoreLocalBackupBundle(target, bundle, { force: true })).resolves.toMatchObject({ stateRoot: target })
  })

  it('rejects a tampered chunk instead of restoring corrupt data', async () => {
    const { root, store } = await seededRoot()
    const bundle = join(root, 'backups', 'tampered.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const lines = (await gunzipAsync(await readFile(bundle))).toString('utf8').split('\n').filter(Boolean)
    const index = lines.findIndex((line) => line.includes('"path":"skills/actions.json"'))
    expect(index).toBeGreaterThan(0)
    const entry = JSON.parse(lines[index]!) as { dataBase64: string }
    entry.dataBase64 = Buffer.from('{"actions":["tampered"]}').toString('base64')
    lines[index] = JSON.stringify(entry)
    const tampered = join(root, 'backups', 'tampered-rewritten.dshbackup')
    await writeFile(tampered, await gzipAsync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')))

    const target = await emptyRoot('dsh-restore-tampered-')
    await expect(restoreLocalBackupBundle(target, tampered)).rejects.toThrow(/failed verification/)
    // Nothing was swapped into place, and no staging directory was left behind.
    await expect(readFile(join(target, 'skills', 'actions.json'), 'utf8')).rejects.toThrow()
  })

  it('refuses an archive path that tries to escape the state root', async () => {
    const root = await emptyRoot('dsh-restore-escape-')
    const bundle = join(root, 'escape.dshbackup')
    const header = JSON.stringify({
      schemaVersion: 2,
      format: 'dsh-cyber-local-backup',
      createdAt: '2026-08-24T00:00:00.000Z',
      included: ['database.sqlite'],
      excluded: [],
      notes: '',
    })
    const payload = Buffer.from('pwned')
    const entry = JSON.stringify({
      path: '../escaped.txt',
      byteLength: payload.byteLength,
      sha256: 'unused',
      chunkIndex: 0,
      chunkCount: 1,
      chunkSha256: 'unused',
      dataBase64: payload.toString('base64'),
    })
    await writeFile(bundle, await gzipAsync(Buffer.from(`${header}\n${entry}\n`, 'utf8')))

    const target = await emptyRoot('dsh-restore-escape-target-')
    await expect(restoreLocalBackupBundle(target, bundle)).rejects.toThrow(/Unsafe backup entry path/)
  })

  it('refuses a bundle from a format it does not understand', async () => {
    const root = await emptyRoot('dsh-restore-format-')
    const bundle = join(root, 'future.dshbackup')
    await writeFile(bundle, await gzipAsync(Buffer.from(`${JSON.stringify({
      schemaVersion: 99,
      format: 'dsh-cyber-local-backup',
      createdAt: '2026-08-24T00:00:00.000Z',
      included: [],
      excluded: [],
      notes: '',
    })}\n`, 'utf8')))
    const target = await emptyRoot('dsh-restore-format-target-')
    await expect(restoreLocalBackupBundle(target, bundle)).rejects.toThrow(/不支持的备份包版本/)
  })
})
