import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

import type { SqliteStore } from '@dsh-cyber/persistence'

/**
 * A bundle is newline-delimited JSON, gzipped as a stream: one header record
 * followed by one record per file chunk.
 *
 * The v1 layout serialized every file into a single JS string, which threw
 * `RangeError: Invalid string length` above roughly 400 MB of state — and
 * because this function is the mandatory pre-update snapshot, that error also
 * made it impossible to ever install another update. Nothing here now holds
 * more than one chunk at a time.
 */
export const LOCAL_BACKUP_SCHEMA_VERSION = 2

/** Base64 of this expands to ~5.6 MB, far below any string limit. */
const CHUNK_BYTES = 4 * 1024 * 1024

export interface LocalBackupBundleHeader {
  schemaVersion: typeof LOCAL_BACKUP_SCHEMA_VERSION
  format: 'dsh-cyber-local-backup'
  createdAt: string
  included: string[]
  excluded: string[]
  notes: string
}

export interface LocalBackupBundleEntry {
  path: string
  /** Size of the whole file, not of this chunk. */
  byteLength: number
  /** SHA-256 of the whole file. */
  sha256: string
  chunkIndex: number
  chunkCount: number
  chunkSha256: string
  dataBase64: string
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
    // Only paths are collected up front; file bodies are read one chunk at a
    // time while the bundle is written, so peak memory does not grow with the
    // size of the state root.
    const sources: BackupSource[] = [{ absolutePath: temporaryDatabase, archivePath: 'database.sqlite' }]
    const included = ['database.sqlite']

    // Every directory here is user-owned durable state. Add new persistent roots
    // to this list before shipping the feature.
    for (const directory of ['worlds', 'assets', 'packages', 'workshop', 'skills', 'integrations']) {
      const source = join(stateRoot, directory)
      if (!await exists(source)) continue
      sources.push(...await collectBackupSources(source, directory, directory === 'worlds'))
      included.push(directory)
    }
    sources.sort((left, right) => left.archivePath.localeCompare(right.archivePath))

    const header: LocalBackupBundleHeader = {
      schemaVersion: LOCAL_BACKUP_SCHEMA_VERSION,
      format: 'dsh-cyber-local-backup',
      createdAt: new Date().toISOString(),
      included,
      excluded: ['credentials', 'runtime', 'worlds/*/cache', 'backups'],
      notes: '包含 SQLite、世界文件/设置/资产、已安装包、创意工坊项目与 Skill 动作。模型密钥和运行时二进制不进入普通备份。逐行 JSON：首行为头部，其余每行是一个文件分片。',
    }
    await pipeline(
      Readable.from(bundleRecords(header, sources), { objectMode: false }),
      createGzip({ level: 6 }),
      createWriteStream(destination, { mode: 0o600 }),
    )
    return destination
  } finally {
    await rm(temporaryDatabase, { force: true })
  }
}

interface BackupSource {
  absolutePath: string
  archivePath: string
}

async function* bundleRecords(
  header: LocalBackupBundleHeader,
  sources: readonly BackupSource[],
): AsyncGenerator<string> {
  yield `${JSON.stringify(header)}\n`
  for (const source of sources) {
    const info = await stat(source.absolutePath)
    const sha256 = await fileDigest(source.absolutePath)
    const chunkCount = Math.max(1, Math.ceil(info.size / CHUNK_BYTES))
    const handle = await open(source.absolutePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, chunkIndex * CHUNK_BYTES)
        const chunk = buffer.subarray(0, bytesRead)
        const entry: LocalBackupBundleEntry = {
          path: source.archivePath,
          byteLength: info.size,
          sha256,
          chunkIndex,
          chunkCount,
          chunkSha256: createHash('sha256').update(chunk).digest('hex'),
          dataBase64: chunk.toString('base64'),
        }
        yield `${JSON.stringify(entry)}\n`
      }
    } finally {
      await handle.close()
    }
    const after = await stat(source.absolutePath)
    if (after.size !== info.size) {
      throw new Error(`Backup read changed during capture: ${basename(source.absolutePath)}`)
    }
  }
}

function fileDigest(source: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(source)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function collectBackupSources(
  source: string,
  archivePrefix: string,
  excludeWorldCache: boolean,
): Promise<BackupSource[]> {
  const result: BackupSource[] = []
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    if (excludeWorldCache && entry.name === 'cache') continue
    const from = join(source, entry.name)
    const archivePath = `${archivePrefix}/${entry.name}`.replaceAll('\\', '/')
    if (entry.isDirectory()) {
      result.push(...await collectBackupSources(from, archivePath, excludeWorldCache))
      continue
    }
    if (!entry.isFile()) continue
    result.push({ absolutePath: from, archivePath })
  }
  return result
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
