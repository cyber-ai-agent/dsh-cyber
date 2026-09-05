import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore, WorkSystemRepository, WorldArtifactRepository, WorldKnowledgeRepository } from '@dsh-cyber/persistence'

import { createLocalBackupBundle, restoreLocalBackupBundle } from '../src/services/local-backup-service.js'
import {
  markLocalRestoreTransactionCommitted,
  prepareLocalRestoreTransaction,
  recoverLocalRestoreTransactions,
  swapLocalRestoreTransaction,
} from '../src/services/local-restore-transaction.js'
import { acquireStateRootLease } from '../src/services/state-root-lease.js'
import { WorldArtifactService } from '../src/services/world-artifact-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'

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
  const workTask = new WorkSystemRepository(store.database).createTask({ workspaceId: workspace.id, worldId: world.id, title: '备份中的任务', description: '恢复后必须保留', priority: 'high', createdBy: 'owner' })
  const worldRoots = new WorldRootService(root)
  const worldRoot = await worldRoots.ensure(world.id)
  await writeFile(join(worldRoot.filesPath, 'note.md'), '# 保留这份笔记\n')
  await writeFile(join(worldRoot.filesPath, 'report.md'), '# 已发布产物\n\n这是恢复后仍可阅读的 Markdown。\n')
  await writeFile(join(worldRoot.knowledgeLibraryPath, 'manual.md'), '# 世界知识\n\n只属于这个世界的资料。\n')
  const knowledge = new WorldKnowledgeRepository(store.database)
  const collection = knowledge.createCollection({
    worldId: world.id,
    name: '测试资料',
    origin: 'folder',
    relativeRoot: 'manual',
  })
  const knowledgeDocument = knowledge.createDocument({
    workspaceId: workspace.id,
    worldId: world.id,
    collectionId: collection.id,
    relativePath: 'manual.md',
    title: '世界知识',
    mimeType: 'text/markdown',
    byteLength: 42,
    sha256: 'a'.repeat(64),
    origin: 'filesystem',
  })
  const artifactService = new WorldArtifactService({
    repository: new WorldArtifactRepository(store.database),
    roots: worldRoots,
  })
  const publication = await artifactService.publishFromWorkspace({
    workspaceId: workspace.id,
    worldId: world.id,
    sourceRelativePath: 'report.md',
    title: '恢复测试报告',
    kind: 'markdown',
    createdByKind: 'owner',
    createdById: 'local-user',
  })
  await mkdir(join(root, 'skills'), { recursive: true })
  await writeFile(join(root, 'skills', 'actions.json'), '{"actions":[]}')
  await mkdir(join(root, 'credentials'), { recursive: true })
  await writeFile(join(root, 'credentials', 'secret.txt'), 'must-not-travel')
  return { root, store, workspace, world, publication, knowledgeDocument, workTask }
}

async function emptyRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('local backup restore', () => {
  it('round-trips a state root a backup can actually recover', async () => {
    const { root, store, world, publication, knowledgeDocument, workTask } = await seededRoot()
    const bundle = join(root, 'backups', 'round-trip.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const target = await emptyRoot('dsh-restore-target-')
    const result = await restoreLocalBackupBundle(target, bundle)

    expect(result.included).toEqual(expect.arrayContaining(['database.sqlite', 'worlds', 'worlds/*/knowledge/library', 'skills']))
    expect(result.files).toBeGreaterThan(0)
    expect(await readFile(join(target, 'worlds', world.id, 'files', 'note.md'), 'utf8')).toContain('保留这份笔记')
    expect(await readFile(join(target, 'worlds', world.id, 'knowledge', 'library', 'manual.md'), 'utf8')).toContain('只属于这个世界')
    expect(await readFile(join(target, 'worlds', world.id, ...publication.version.relativePath.split('/')), 'utf8')).toContain('已发布产物')
    expect(await readFile(join(target, 'skills', 'actions.json'), 'utf8')).toBe('{"actions":[]}')

    // The restored database is a working database, not just bytes on disk.
    const restored = await SqliteStore.open(join(target, 'data', 'dsh-cyber.sqlite'))
    stores.push(restored)
    expect(restored.getWorld(world.id)?.name).toBe('我的世界')
    expect(new WorkSystemRepository(restored.database).getTask(workTask.id)).toMatchObject({ title: '备份中的任务', status: 'draft' })
    expect(new WorldKnowledgeRepository(restored.database).getDocument(world.id, knowledgeDocument.id)).toMatchObject({ title: '世界知识' })
    const restoredArtifacts = new WorldArtifactService({
      repository: new WorldArtifactRepository(restored.database),
      roots: new WorldRootService(target),
    })
    expect(restoredArtifacts.get(world.id, publication.artifact.id).artifact.title).toBe('恢复测试报告')
    await expect(restoredArtifacts.preview(world.id, publication.artifact.id)).resolves.toMatchObject({
      contentType: 'text/markdown; charset=utf-8',
    })
    expect((await restoredArtifacts.preview(world.id, publication.artifact.id)).body.toString('utf8')).toContain('恢复后仍可阅读')
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

  it('refuses the live database spelling as a second archive identity', async () => {
    const { root, store } = await seededRoot()
    const bundle = join(root, 'backups', 'database-alias.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const lines = (await gunzipAsync(await readFile(bundle))).toString('utf8').split('\n').filter(Boolean)
    for (let index = 1; index < lines.length; index += 1) {
      const entry = JSON.parse(lines[index]!) as { path: string }
      if (entry.path === 'database.sqlite') {
        entry.path = 'data/dsh-cyber.sqlite'
        lines[index] = JSON.stringify(entry)
      }
    }
    const alias = join(root, 'backups', 'database-alias-rewritten.dshbackup')
    await writeFile(alias, await gzipAsync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')))
    const target = await emptyRoot('dsh-restore-database-alias-target-')
    await expect(restoreLocalBackupBundle(target, alias)).rejects.toThrow(/Unsafe backup entry path/)
  })

  it('rejects Windows device, stream, and normalized-name archive segments', async () => {
    if (process.platform !== 'win32') return
    const target = await emptyRoot('dsh-restore-win32-path-target-')
    const paths = ['assets/CON.txt', 'assets/file:stream', 'assets/file.']
    for (const [index, archivePath] of paths.entries()) {
      const root = await emptyRoot('dsh-restore-win32-path-')
      const bundle = join(root, `bundle-${index}.dshbackup`)
      const header = JSON.stringify({
        schemaVersion: 2,
        format: 'dsh-cyber-local-backup',
        createdAt: '2026-08-24T00:00:00.000Z',
        included: ['assets'],
        excluded: [],
        notes: '',
      })
      const entry = JSON.stringify({
        path: archivePath,
        byteLength: 1,
        sha256: 'a'.repeat(64),
        chunkIndex: 0,
        chunkCount: 1,
        chunkSha256: 'a'.repeat(64),
        dataBase64: 'eA==',
      })
      await writeFile(bundle, await gzipAsync(Buffer.from(`${header}\n${entry}\n`, 'utf8')))
      await expect(restoreLocalBackupBundle(target, bundle)).rejects.toThrow(/Unsafe backup entry path/)
    }
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

  it('publishes a complete backup without clobbering an existing destination', async () => {
    const { root, store } = await seededRoot()
    const output = join(root, 'backups', 'existing.dshbackup')
    await mkdir(join(root, 'backups'), { recursive: true })
    await writeFile(output, 'previous-artifact', 'utf8')

    await expect(createLocalBackupBundle(root, store, { output })).rejects.toThrow()
    expect(await readFile(output, 'utf8')).toBe('previous-artifact')

    const leftovers = await readdir(join(root, 'backups'))
    expect(leftovers.filter((name) => name.endsWith('.sqlite') || name.includes('.tmp-') || name.startsWith('.dsh-cyber-verify-'))).toEqual([])
  })

  it('rejects a same-size source mutation before publishing a backup', async () => {
    const { root, store } = await seededRoot()
    const path = join(root, 'skills', 'same-size.txt')
    await writeFile(path, 'before\n', 'utf8')
    const output = join(root, 'backups', 'same-size.dshbackup')

    await expect(createLocalBackupBundle(root, store, {
      output,
      onPoint: async (point, context) => {
        if (point === 'after-source-digest' && context.path === 'skills/same-size.txt') await writeFile(path, 'after!\n', 'utf8')
      },
    })).rejects.toThrow(/changed during capture/)
    await expect(stat(output)).rejects.toThrow()
    const leftovers = await readdir(join(root, 'backups'))
    expect(leftovers.filter((name) => name.endsWith('.sqlite') || name.includes('.tmp-'))).toEqual([])
  })

  it('rejects backup output inside an included durable root', async () => {
    const { root, store } = await seededRoot()
    await expect(createLocalBackupBundle(root, store, { output: join(root, 'skills', 'invalid.dshbackup') })).rejects.toThrow(/outside durable state roots/)
  })

  it('propagates truncated gzip errors and leaves no restore staging residue', async () => {
    const sourceRoot = await emptyRoot('dsh-restore-invalid-gzip-')
    const bundle = join(sourceRoot, 'invalid.dshbackup')
    await writeFile(bundle, Buffer.from('not a gzip stream', 'utf8'))
    const target = await emptyRoot('dsh-restore-invalid-gzip-target-')

    await expect(restoreLocalBackupBundle(target, bundle)).rejects.toThrow()
    const entries = await readdir(target)
    expect(entries.some((entry) => entry.startsWith('.restore-staging-'))).toBe(false)
    expect(entries).not.toContain('.restore-transactions')
  })

  it('preserves target-only excluded paths while replacing empty included roots', async () => {
    const { root, store, world } = await seededRoot()
    await mkdir(join(root, 'assets'), { recursive: true })
    const bundle = join(root, 'backups', 'excluded-target.dshbackup')
    await createLocalBackupBundle(root, store, { output: bundle })
    store.close()

    const cache = join(root, 'worlds', world.id, 'cache', 'compiled.bin')
    await mkdir(join(root, 'worlds', world.id, 'cache'), { recursive: true })
    await writeFile(cache, 'keep-cache', 'utf8')
    await writeFile(join(root, 'credentials', 'secret.txt'), 'target-secret', 'utf8')
    await mkdir(join(root, 'runtime', 'candidate'), { recursive: true })
    await writeFile(join(root, 'runtime', 'candidate', 'marker.txt'), 'keep-runtime', 'utf8')
    await mkdir(join(root, 'backups'), { recursive: true })
    await writeFile(join(root, 'backups', 'old-artifact.txt'), 'keep-backup', 'utf8')
    await writeFile(join(root, 'assets', 'stale.txt'), 'remove-with-empty-root', 'utf8')

    await restoreLocalBackupBundle(root, bundle, { force: true })

    expect(await readFile(cache, 'utf8')).toBe('keep-cache')
    expect(await readFile(join(root, 'credentials', 'secret.txt'), 'utf8')).toBe('target-secret')
    expect(await readFile(join(root, 'runtime', 'candidate', 'marker.txt'), 'utf8')).toBe('keep-runtime')
    expect(await readFile(join(root, 'backups', 'old-artifact.txt'), 'utf8')).toBe('keep-backup')
    await expect(readFile(join(root, 'assets', 'stale.txt'), 'utf8')).rejects.toThrow()
    expect((await stat(bundle)).isFile()).toBe(true)
  })

  it('recovers initial roots after a crash between rename operations', async () => {
    const root = await emptyRoot('dsh-restore-journal-crash-')
    const release = await acquireStateRootLease(root)
    try {
      await mkdir(join(root, 'data'), { recursive: true })
      await writeFile(join(root, 'data', 'old.txt'), 'old-data', 'utf8')
      await mkdir(join(root, 'worlds', 'world-a', 'cache'), { recursive: true })
      await writeFile(join(root, 'worlds', 'world-a', 'cache', 'old.bin'), 'old-cache', 'utf8')
      const staging = join(root, '.fixture-stage')
      await mkdir(join(staging, 'data'), { recursive: true })
      await mkdir(join(staging, 'worlds', 'world-a'), { recursive: true })
      await writeFile(join(staging, 'data', 'new.txt'), 'new-data', 'utf8')
      await writeFile(join(staging, 'worlds', 'world-a', 'new.txt'), 'new-world', 'utf8')
      const transaction = await prepareLocalRestoreTransaction({
        stateRoot: root,
        bundlePath: join(root, 'bundle.dshbackup'),
        stagingPath: staging,
        topLevelEntries: ['data', 'worlds'],
      })

      await expect(swapLocalRestoreTransaction(transaction, {
        onPoint: (point, context) => {
          if (point === 'after-root-install' && context.topLevel === 'data') throw new Error('simulated crash')
        },
      })).rejects.toThrow('simulated crash')
      expect(await readFile(join(root, 'data', 'new.txt'), 'utf8')).toBe('new-data')

      await recoverLocalRestoreTransactions(root)
      expect(await readFile(join(root, 'data', 'old.txt'), 'utf8')).toBe('old-data')
      expect(await readFile(join(root, 'worlds', 'world-a', 'cache', 'old.bin'), 'utf8')).toBe('old-cache')
      await expect(stat(join(root, '.restore-transactions'))).rejects.toThrow()
    } finally {
      await release()
    }
  })

  it('keeps rollback rescue copies when recovery itself fails', async () => {
    const root = await emptyRoot('dsh-restore-journal-rescue-')
    const release = await acquireStateRootLease(root)
    try {
      await mkdir(join(root, 'data'), { recursive: true })
      await writeFile(join(root, 'data', 'old.txt'), 'old-data', 'utf8')
      const staging = join(root, '.fixture-stage')
      await mkdir(join(staging, 'data'), { recursive: true })
      await writeFile(join(staging, 'data', 'new.txt'), 'new-data', 'utf8')
      const transaction = await prepareLocalRestoreTransaction({
        stateRoot: root,
        bundlePath: join(root, 'bundle.dshbackup'),
        stagingPath: staging,
        topLevelEntries: ['data'],
      })
      await swapLocalRestoreTransaction(transaction)

      await expect(recoverLocalRestoreTransactions(root, {
        onPoint: (point) => {
          if (point === 'after-recovery-live-remove') throw new Error('simulated rollback failure')
        },
      })).rejects.toThrow('simulated rollback failure')
      const rescue = join(root, '.restore-transactions', transaction.journal.transactionId, 'rollback', 'data', 'old.txt')
      expect(await readFile(rescue, 'utf8')).toBe('old-data')
      await expect(readFile(join(root, 'data', 'new.txt'), 'utf8')).rejects.toThrow()

      await recoverLocalRestoreTransactions(root)
      expect(await readFile(join(root, 'data', 'old.txt'), 'utf8')).toBe('old-data')
    } finally {
      await release()
    }
  })

  it('keeps the committed generation when cleanup is recovered later', async () => {
    const root = await emptyRoot('dsh-restore-journal-commit-')
    const release = await acquireStateRootLease(root)
    try {
      await mkdir(join(root, 'data'), { recursive: true })
      await writeFile(join(root, 'data', 'old.txt'), 'old-data', 'utf8')
      const staging = join(root, '.fixture-stage')
      await mkdir(join(staging, 'data'), { recursive: true })
      await writeFile(join(staging, 'data', 'new.txt'), 'new-data', 'utf8')
      const transaction = await prepareLocalRestoreTransaction({
        stateRoot: root,
        bundlePath: join(root, 'bundle.dshbackup'),
        stagingPath: staging,
        topLevelEntries: ['data'],
      })
      await swapLocalRestoreTransaction(transaction)
      await markLocalRestoreTransactionCommitted(transaction)

      await recoverLocalRestoreTransactions(root)
      expect(await readFile(join(root, 'data', 'new.txt'), 'utf8')).toBe('new-data')
      await expect(stat(join(root, '.restore-transactions'))).rejects.toThrow()
    } finally {
      await release()
    }
  })
})
