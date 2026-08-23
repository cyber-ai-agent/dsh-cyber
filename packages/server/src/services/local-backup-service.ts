import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

import type { SqliteStore } from '@dsh-cyber/persistence'

const gzipAsync = promisify(gzip)

interface BackupBundleEntry {
  path: string
  byteLength: number
  sha256: string
  dataBase64: string
}

export interface LocalBackupBundleV1 {
  schemaVersion: 1
  format: 'dsh-cyber-local-backup'
  createdAt: string
  included: string[]
  excluded: string[]
  entries: BackupBundleEntry[]
  notes: string
}

export interface CreateLocalBackupOptions {
  output?: string
}

/**
 * Captures user-owned local state while intentionally excluding credentials,
 * runtime binaries/caches and prior backup artifacts.
 *
 * This is the upgrade safety boundary for local-first DSH Cyber. Source-code or
 * bundled-runtime updates must never be used as a substitute for mutating stateRoot.
 */
export async function createLocalBackupBundle(
  stateRoot: string,
  store: SqliteStore,
  options: CreateLocalBackupOptions = {},
): Promise<string> {
  const backupRoot = join(stateRoot, 'backups')
  await mkdir(backupRoot, { recursive: true })
  const timestamp = artifactTimestamp()
  const temporaryDatabase = join(backupRoot, `.dsh-cyber-${timestamp}.sqlite`)
  const destination = resolve(options.output ?? join(backupRoot, `dsh-cyber-${timestamp}.dshbackup`))
  await mkdir(dirname(destination), { recursive: true })

  await store.backup(temporaryDatabase)
  try {
    const entries: BackupBundleEntry[] = [await backupEntry(temporaryDatabase, 'database.sqlite')]
    const included = ['database.sqlite']

    // Every directory here is user-owned durable state. Add new persistent roots
    // to this list before shipping the feature.
    for (const directory of ['worlds', 'assets', 'packages', 'workshop', 'skills']) {
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
      notes: '包含 SQLite、世界文件/设置/资产、已安装包、创意工坊项目与 Skill 动作。模型密钥和运行时二进制不进入普通备份。',
    }
    const compressed = await gzipAsync(Buffer.from(`${JSON.stringify(bundle)}\n`, 'utf8'), { level: 6 })
    await writeFile(destination, compressed, { mode: 0o600 })
    return destination
  } finally {
    await rm(temporaryDatabase, { force: true })
  }
}

async function collectBackupEntries(
  source: string,
  archivePrefix: string,
  excludeWorldCache: boolean,
): Promise<BackupBundleEntry[]> {
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
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function artifactTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}
