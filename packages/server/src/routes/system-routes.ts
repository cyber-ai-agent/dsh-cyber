import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import {
  inspectHarnessCompatibility,
  readActiveHarnessRuntime,
} from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, requiredBoolean, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { RuntimeUpdateService } from '../services/runtime-update-service.js'

const gzipAsync = promisify(gzip)

export interface SystemRoutesDependencies {
  store: SqliteStore
  stateRoot: string
  runtimeUpdates: RuntimeUpdateService
}

interface BackupBundleEntry {
  path: string
  byteLength: number
  sha256: string
  dataBase64: string
}

interface LocalBackupBundleV1 {
  schemaVersion: 1
  format: 'dsh-cyber-local-backup'
  createdAt: string
  included: string[]
  excluded: string[]
  entries: BackupBundleEntry[]
  notes: string
}

export function registerSystemRoutes(router: Router, dependencies: SystemRoutesDependencies): void {
  const { store, stateRoot, runtimeUpdates } = dependencies
  const runtimeRoot = join(stateRoot, 'runtime')

  router.get('/api/health', ({ response }) => {
    writeJson(response, 200, { ok: true, database: store.doctor() })
  })

  router.get('/api/system/compatibility', async ({ response }) => {
    const compatibility = await inspectHarnessCompatibility(join(runtimeRoot, 'harness-home'))
    writeJson(response, compatibility.ok ? 200 : 503, compatibility)
  })

  router.get('/api/system/status', async ({ response }) => {
    const compatibility = await inspectHarnessCompatibility(join(runtimeRoot, 'harness-home'))
    const database = store.doctor()
    writeJson(response, 200, {
      ok: compatibility.ok && database.ok,
      checkedAt: new Date().toISOString(),
      stateRoot,
      database,
      compatibility,
      activeRuntime: await readActiveHarnessRuntime(runtimeRoot),
      runtimeUpdates: store.listRuntimeUpdateTransactions().slice(0, 10),
    })
  })

  router.post('/api/system/doctor', ({ response }) => {
    const database = store.doctor()
    writeJson(response, 200, { ok: database.ok, checkedAt: new Date().toISOString(), database })
  })

  router.post('/api/system/backup', async ({ response }) => {
    const output = await createLocalBackupBundle(stateRoot, store)
    writeJson(response, 201, {
      ok: true,
      kind: 'backup-bundle',
      output,
      createdAt: new Date().toISOString(),
      excluded: ['credentials', 'runtime', 'world-cache'],
    })
  })

  router.post('/api/system/export', async ({ response }) => {
    const destination = join(stateRoot, 'backups', `dsh-cyber-${artifactTimestamp()}.json`)
    const output = await store.exportJson(destination)
    writeJson(response, 201, { ok: true, kind: 'export', output, createdAt: new Date().toISOString() })
  })

  router.post('/api/system/update/verify', async ({ request, response }) => {
    const body = await readJson(request)
    const result = await runtimeUpdates.verify(requiredString(body, 'candidateRoot'))
    if (result.transaction === undefined) {
      writeJson(response, 200, result.report)
      return
    }
    writeJson(response, 201, { ...result.report, transaction: result.transaction })
  })

  router.get('/api/system/updates', async ({ response }) => {
    writeJson(response, 200, {
      items: store.listRuntimeUpdateTransactions(),
      activeRuntime: await readActiveHarnessRuntime(runtimeRoot),
    })
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/contract-test$/, async ({ response, params }) => {
    const result = await runtimeUpdates.contractTest(params[0]!)
    writeJson(response, result.ok ? 200 : 422, result)
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/canary$/, async ({ request, response, params }) => {
    if (store.getRuntimeUpdateTransaction(params[0]!) === undefined) {
      throw new HttpError(404, 'runtime_update_not_found', 'Runtime update transaction not found')
    }
    const body = await readJson(request)
    const result = await runtimeUpdates.canary(params[0]!, requiredString(body, 'modelProfileId'))
    writeJson(response, result.ok ? 200 : 422, result)
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/activate$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    writeJson(response, 200, await runtimeUpdates.activate(params[0]!, requiredBoolean(body, 'approved')))
  })

  router.post(/^\/api\/system\/update\/([^/]+)\/rollback$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    writeJson(response, 200, await runtimeUpdates.rollback(params[0]!, requiredBoolean(body, 'approved')))
  })
}

async function createLocalBackupBundle(stateRoot: string, store: SqliteStore): Promise<string> {
  const backupRoot = join(stateRoot, 'backups')
  await mkdir(backupRoot, { recursive: true })
  const timestamp = artifactTimestamp()
  const temporaryDatabase = join(backupRoot, `.dsh-cyber-${timestamp}.sqlite`)
  const destination = join(backupRoot, `dsh-cyber-${timestamp}.dshbackup`)

  await store.backup(temporaryDatabase)
  try {
    const entries: BackupBundleEntry[] = [await backupEntry(temporaryDatabase, 'database.sqlite')]
    const included = ['database.sqlite']
    for (const directory of ['worlds', 'assets', 'packages']) {
      const source = join(stateRoot, directory)
      if (!await exists(source)) continue
      entries.push(...await collectBackupEntries(source, directory, directory === 'worlds'))
      included.push(directory)
    }

    entries.sort((left, right) => left.path.localeCompare(right.path))
    const bundle: LocalBackupBundleV1 = {
      schemaVersion: 1,
      format: 'dsh-cyber-local-backup',
      createdAt: new Date().toISOString(),
      included,
      excluded: ['credentials', 'runtime', 'worlds/*/cache', 'backups'],
      entries,
      notes: '模型密钥不会进入普通备份；世界访问锁、世界设置、文件与世界资产均包含在 Bundle 中。',
    }
    const compressed = await gzipAsync(Buffer.from(`${JSON.stringify(bundle)}\n`, 'utf8'), { level: 6 })
    await writeFile(destination, compressed, { mode: 0o600 })
    return destination
  } finally {
    await rm(temporaryDatabase, { force: true })
  }
}

async function collectBackupEntries(source: string, archivePrefix: string, excludeWorldCache: boolean): Promise<BackupBundleEntry[]> {
  const result: BackupBundleEntry[] = []
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (excludeWorldCache && entry.name === 'cache') continue
    const from = join(source, entry.name)
    const archivePath = `${archivePrefix}/${entry.name}`.replaceAll('\\', '/')
    if (entry.isDirectory()) {
      result.push(...await collectBackupEntries(from, archivePath, excludeWorldCache))
      continue
    }
    if (!entry.isFile()) continue
    result.push(await backupEntry(from, archivePath))
  }
  return result
}

async function backupEntry(source: string, archivePath: string): Promise<BackupBundleEntry> {
  const body = await readFile(source)
  const info = await stat(source)
  if (info.size !== body.byteLength) throw new Error(`Backup read changed during capture: ${basename(source)}`)
  return {
    path: archivePath,
    byteLength: body.byteLength,
    sha256: createHash('sha256').update(body).digest('hex'),
    dataBase64: body.toString('base64'),
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

function artifactTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}
