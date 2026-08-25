import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

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


export interface RestoreLocalBackupOptions {
  /** Replace an existing state root instead of refusing to touch it. */
  force?: boolean
}

export interface RestoreLocalBackupResult {
  createdAt: string
  included: string[]
  files: number
  bytes: number
  stateRoot: string
}

/** Where the live database sits inside a state root. */
const DATABASE_ARCHIVE_PATH = 'database.sqlite'
const DATABASE_TARGET_PATH = join('data', 'dsh-cyber.sqlite')

/**
 * Restores a `.dshbackup` into a state root.
 *
 * The bundle was write-only until now, which meant the mandatory pre-update
 * snapshot was not actually a recovery path. Everything is verified before
 * anything is replaced: each chunk against its digest, each file against the
 * whole-file digest, and every archive path against the state root. Only once
 * the entire bundle has materialized in a staging directory is it swapped in.
 */
export async function restoreLocalBackupBundle(
  stateRoot: string,
  bundlePath: string,
  options: RestoreLocalBackupOptions = {},
): Promise<RestoreLocalBackupResult> {
  const root = resolve(stateRoot)
  const source = resolve(bundlePath)
  const existingDatabase = join(root, DATABASE_TARGET_PATH)
  if (options.force !== true && await exists(existingDatabase)) {
    throw new Error(`State root already holds a database: ${existingDatabase}。请先备份，再使用 --force 覆盖。`)
  }

  await mkdir(root, { recursive: true })
  const staging = join(root, `.restore-staging-${artifactTimestamp()}`)
  await mkdir(staging, { recursive: true })
  try {
    const materialized = await materializeBundle(source, staging)
    // Only now is anything in the live state root touched.
    for (const top of new Set(materialized.topLevelEntries)) {
      await rm(join(root, top), { recursive: true, force: true })
      await mkdir(dirname(join(root, top)), { recursive: true })
      await rename(join(staging, top), join(root, top))
    }
    return {
      createdAt: materialized.header.createdAt,
      included: materialized.header.included,
      files: materialized.files,
      bytes: materialized.bytes,
      stateRoot: root,
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

interface MaterializedBundle {
  header: LocalBackupBundleHeader
  files: number
  bytes: number
  topLevelEntries: string[]
}

async function materializeBundle(source: string, staging: string): Promise<MaterializedBundle> {
  const lines = createInterface({ input: createReadStream(source).pipe(createGunzip()), crlfDelay: Infinity })
  let header: LocalBackupBundleHeader | undefined
  const topLevelEntries: string[] = []
  let current: { path: string; target: string; digest: ReturnType<typeof createHash>; expected: string; written: number; chunks: number; chunkCount: number } | undefined
  let files = 0
  let bytes = 0

  const finishFile = (): void => {
    if (current === undefined) return
    if (current.chunks !== current.chunkCount) {
      throw new Error(`Backup entry is incomplete: ${current.path}`)
    }
    const actual = current.digest.digest('hex')
    if (actual !== current.expected) throw new Error(`Backup entry failed verification: ${current.path}`)
    files += 1
    current = undefined
  }

  for await (const line of lines) {
    if (line.trim().length === 0) continue
    if (header === undefined) {
      header = JSON.parse(line) as LocalBackupBundleHeader
      if (header.format !== 'dsh-cyber-local-backup') throw new Error('不是 DSH Cyber 备份包')
      if (header.schemaVersion !== LOCAL_BACKUP_SCHEMA_VERSION) {
        throw new Error(`不支持的备份包版本：${String(header.schemaVersion)}（当前支持 ${LOCAL_BACKUP_SCHEMA_VERSION}）`)
      }
      continue
    }
    const entry = JSON.parse(line) as LocalBackupBundleEntry
    if (current?.path !== entry.path) {
      finishFile()
      const target = restoreTargetPath(staging, entry.path)
      topLevelEntries.push(topLevelOf(entry.path))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, '')
      current = {
        path: entry.path,
        target,
        digest: createHash('sha256'),
        expected: entry.sha256,
        written: 0,
        chunks: 0,
        chunkCount: entry.chunkCount,
      }
    }
    if (entry.chunkIndex !== current.chunks) {
      throw new Error(`Backup chunks are out of order: ${entry.path}`)
    }
    const chunk = Buffer.from(entry.dataBase64, 'base64')
    if (createHash('sha256').update(chunk).digest('hex') !== entry.chunkSha256) {
      throw new Error(`Backup chunk failed verification: ${entry.path}#${entry.chunkIndex}`)
    }
    await appendFile(current.target, chunk)
    current.digest.update(chunk)
    current.written += chunk.byteLength
    current.chunks += 1
    bytes += chunk.byteLength
  }
  finishFile()
  if (header === undefined) throw new Error('备份包是空的')
  return { header, files, bytes, topLevelEntries }
}

/** Maps an archive path into the staging tree, refusing anything that escapes. */
function restoreTargetPath(staging: string, archivePath: string): string {
  if (archivePath.length === 0 || archivePath.startsWith('/') || archivePath.includes('\\')) {
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  const mapped = archivePath === DATABASE_ARCHIVE_PATH ? DATABASE_TARGET_PATH : archivePath
  const target = resolve(join(staging, mapped))
  const inside = relative(resolve(staging), target)
  if (inside.length === 0 || inside.startsWith('..') || inside.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  return target
}

function topLevelOf(archivePath: string): string {
  const mapped = archivePath === DATABASE_ARCHIVE_PATH ? DATABASE_TARGET_PATH : archivePath
  return mapped.split(/[\\/]/)[0]!
}
