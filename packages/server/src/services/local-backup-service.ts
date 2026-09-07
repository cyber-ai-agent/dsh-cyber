import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, link, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { createGunzip, createGzip } from 'node:zlib'

import type { SqliteStore } from '@dsh-cyber/persistence'

import { acquireStateRootLease } from './state-root-lease.js'
import {
  cleanupLocalRestoreTransaction,
  markLocalRestoreTransactionCommitted,
  prepareLocalRestoreTransaction,
  preserveExcludedWorldCaches,
  recoverLocalRestoreTransactions as recoverRestoreTransactions,
  setLocalRestoreTransactionPhase,
  swapLocalRestoreTransaction,
  type LocalRestoreTransaction,
  type LocalRestoreTransactionHookContext,
} from './local-restore-transaction.js'

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
  /** Internal deterministic fault seam used by recovery tests. */
  onPoint?: (point: LocalBackupHookPoint, context: LocalBackupHookContext) => void | Promise<void>
}

export interface LocalBackupHookContext {
  phase: 'backup'
  path?: string
  chunkIndex?: number
}

export type LocalBackupHookPoint =
  | 'after-source-digest'
  | 'after-source-chunk'
  | 'before-publish'
  | 'after-publish'

export type LocalBackupRestoreHookPoint =
  | LocalBackupHookPoint
  | 'after-restore-prepared'
  | 'after-root-backup'
  | 'after-root-install'
  | 'after-excluded-preserve'
  | 'after-restore-validated'
  | 'before-restore-commit'
  | 'after-restore-commit'
  | 'before-recovery-rollback'
  | 'after-recovery-live-remove'
  | 'after-recovery-root-restore'

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
  const root = resolve(stateRoot)
  const backupRoot = join(root, 'backups')
  await mkdir(backupRoot, { recursive: true })
  const transactionId = randomUUID()
  const temporaryDatabase = join(backupRoot, `.dsh-cyber-${transactionId}.sqlite`)
  const destination = resolve(options.output ?? join(backupRoot, `dsh-cyber-${artifactTimestamp()}-${transactionId}.dshbackup`))
  assertBackupDestination(root, destination)
  await mkdir(dirname(destination), { recursive: true })
  const temporaryBundle = `${destination}.tmp-${transactionId}`
  let published = false
  try {
    await store.backup(temporaryDatabase)
    await syncFile(temporaryDatabase)
    // Only paths are collected up front; file bodies are read one chunk at a
    // time while the bundle is written, so peak memory does not grow with the
    // size of the state root.
    const sources: BackupSource[] = [{ absolutePath: temporaryDatabase, archivePath: 'database.sqlite' }]
    const included = ['database.sqlite']

    // Every directory here is user-owned durable state. Add new persistent roots
    // to this list before shipping the feature.
    for (const directory of ['worlds', 'assets', 'packages', 'workshop', 'skills', 'integrations']) {
      const source = join(root, directory)
      if (!await exists(source)) continue
      sources.push(...await collectBackupSources(source, directory, directory === 'worlds'))
      included.push(directory)
    }
    // Knowledge source files are nested under worlds and are intentionally
    // captured by the same recursive walk. Advertise the durable sub-root in
    // the manifest when it contains files so restore/doctor tooling can show
    // that the source authority traveled with the SQLite projection.
    if (sources.some(({ archivePath }) => /^worlds\/[^/]+\/knowledge\/library(?:\/|$)/.test(archivePath))) {
      included.push('worlds/*/knowledge/library')
    }
    sources.sort((left, right) => left.archivePath.localeCompare(right.archivePath))

    const header: LocalBackupBundleHeader = {
      schemaVersion: LOCAL_BACKUP_SCHEMA_VERSION,
      format: 'dsh-cyber-local-backup',
      createdAt: new Date().toISOString(),
      included,
      excluded: ['credentials', 'runtime', 'worlds/*/cache', 'backups'],
      notes: '包含 SQLite、世界文件/设置/资产、knowledge/library、已安装包、创意工坊项目与 Skill 动作。模型密钥和运行时二进制不进入普通备份。逐行 JSON：首行为头部，其余每行是一个文件分片。',
    }
    await pipeline(
      Readable.from(bundleRecords(header, sources, options.onPoint), { objectMode: false }),
      createGzip({ level: 6 }),
      createWriteStream(temporaryBundle, { flags: 'wx', mode: 0o600 }),
    )
    await syncFile(temporaryBundle)
    const verificationRoot = join(backupRoot, `.dsh-cyber-verify-${transactionId}`)
    await mkdir(verificationRoot, { recursive: true })
    try {
      await materializeBundle(temporaryBundle, verificationRoot)
      await validateRestoredDatabase(join(verificationRoot, DATABASE_TARGET_PATH))
    } finally {
      await rm(verificationRoot, { recursive: true, force: true })
    }
    await options.onPoint?.('before-publish', { phase: 'backup' })
    // Hard-link publication is atomic and no-clobber on the same filesystem;
    // the temporary file is deliberately created beside the destination.
    await link(temporaryBundle, destination)
    published = true
    await rm(temporaryBundle, { force: true })
    await options.onPoint?.('after-publish', { phase: 'backup' })
    return destination
  } finally {
    try {
      await rm(temporaryDatabase, { force: true })
    } finally {
      if (!published) await rm(temporaryBundle, { force: true })
    }
  }
}

interface BackupSource {
  absolutePath: string
  archivePath: string
}

async function* bundleRecords(
  header: LocalBackupBundleHeader,
  sources: readonly BackupSource[],
  onPoint?: CreateLocalBackupOptions['onPoint'],
): AsyncGenerator<string> {
  yield `${JSON.stringify(header)}\n`
  for (const source of sources) {
    const info = await stat(source.absolutePath)
    const sha256 = await fileDigest(source.absolutePath)
    await onPoint?.('after-source-digest', { phase: 'backup', path: source.archivePath })
    const chunkCount = Math.max(1, Math.ceil(info.size / CHUNK_BYTES))
    const capturedDigest = createHash('sha256')
    let capturedBytes = 0
    const handle = await open(source.absolutePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, chunkIndex * CHUNK_BYTES)
        const expectedBytes = Math.max(0, Math.min(CHUNK_BYTES, info.size - chunkIndex * CHUNK_BYTES))
        if (bytesRead !== expectedBytes) {
          throw new Error(`Backup read changed during capture: ${basename(source.absolutePath)}`)
        }
        const chunk = buffer.subarray(0, bytesRead)
        capturedDigest.update(chunk)
        capturedBytes += chunk.byteLength
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
        await onPoint?.('after-source-chunk', { phase: 'backup', path: source.archivePath, chunkIndex })
      }
    } finally {
      await handle.close()
    }
    const after = await stat(source.absolutePath)
    if (capturedBytes !== info.size || capturedDigest.digest('hex') !== sha256 || !sameFileSnapshot(info, after)) {
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

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function assertBackupDestination(stateRoot: string, destination: string): void {
  const inside = relative(resolve(stateRoot), resolve(destination))
  if (inside.length === 0 || inside.startsWith('..') || inside.startsWith(`..${sep}`)) return
  const topLevel = inside.split(/[\\/]/)[0]
  if (topLevel === undefined) return
  if (new Set(['data', 'worlds', 'assets', 'packages', 'workshop', 'skills', 'integrations', 'credentials', 'runtime']).has(topLevel) ||
    topLevel === '.state-root-lease.sqlite' || topLevel === '.restore-transactions' || topLevel.startsWith('.restore-staging-') || topLevel.startsWith('.dsh-cyber-verify-')) {
    throw new Error('Backup output must be outside durable state roots; use the backups directory or an external path')
  }
}

function sameFileSnapshot(left: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }, right: { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }): boolean {
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}


export interface RestoreLocalBackupOptions {
  /** Replace an existing state root instead of refusing to touch it. */
  force?: boolean
  /** Internal deterministic fault seam used by recovery tests. */
  onPoint?: (point: LocalBackupRestoreHookPoint, context: LocalRestoreTransactionHookContext) => void | Promise<void>
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
  const release = await acquireStateRootLease(root)
  let staging: string | undefined
  let transaction: LocalRestoreTransaction | undefined
  let committed = false
  try {
    // A previous process may have died after one of the rename operations. The
    // lease is already held, so recovery must not attempt to reacquire it.
    await recoverLocalRestoreTransactions(root)
    const existingDatabase = join(root, DATABASE_TARGET_PATH)
    if (options.force !== true && await exists(existingDatabase)) {
      throw new Error(`State root already holds a database: ${existingDatabase}。请先备份，再使用 --force 覆盖。`)
    }
    staging = join(root, `.restore-staging-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    const materialized = await materializeBundle(source, staging)
    await validateRestoredDatabase(join(staging, DATABASE_TARGET_PATH))
    transaction = await prepareLocalRestoreTransaction({
      stateRoot: root,
      bundlePath: source,
      stagingPath: staging,
      topLevelEntries: materialized.topLevelEntries,
      createdAt: materialized.header.createdAt,
    })
    staging = undefined
    await options.onPoint?.('after-restore-prepared', {
      transactionId: transaction.journal.transactionId,
      phase: 'prepared',
    })
    const transactionHooks = options.onPoint === undefined ? {} : { onPoint: options.onPoint }
    transaction = await swapLocalRestoreTransaction(transaction, transactionHooks)
    transaction = await preserveExcludedWorldCaches(transaction, transactionHooks)
    await validateRestoredDatabase(join(root, DATABASE_TARGET_PATH))
    await options.onPoint?.('after-restore-validated', {
      transactionId: transaction.journal.transactionId,
      phase: 'validated',
    })
    transaction = await setLocalRestoreTransactionPhase(transaction, 'validated')
    await options.onPoint?.('before-restore-commit', {
      transactionId: transaction.journal.transactionId,
      phase: 'validated',
    })
    transaction = await markLocalRestoreTransactionCommitted(transaction)
    committed = true
    await options.onPoint?.('after-restore-commit', {
      transactionId: transaction.journal.transactionId,
      phase: 'committed',
    })
    // If cleanup is interrupted, the committed journal remains and the next
    // startup removes only the rollback/staging residue.
    await cleanupLocalRestoreTransaction(transaction)
    return {
      createdAt: materialized.header.createdAt,
      included: materialized.header.included,
      files: materialized.files,
      bytes: materialized.bytes,
      stateRoot: root,
    }
  } catch (error) {
    if (transaction !== undefined && !committed) {
      // Roll back synchronously where possible. If the disk itself prevents
      // recovery, the journal and rescue roots remain for the next startup.
      try {
        await recoverLocalRestoreTransactions(root, options.onPoint === undefined ? {} : { onPoint: options.onPoint })
      } catch (recoveryError) {
        throw new Error(`Restore failed and recovery is pending: ${errorMessage(error)}`, { cause: recoveryError })
      }
    }
    throw error
  } finally {
    try {
      if (staging !== undefined) await rm(staging, { recursive: true, force: true })
    } finally {
      await release()
    }
  }
}

/** Recovery is called by server startup while its state-root lease is held. */
export async function recoverLocalRestoreTransactions(
  stateRoot: string,
  options: Pick<RestoreLocalBackupOptions, 'onPoint'> = {},
): Promise<void> {
  await recoverRestoreTransactions(stateRoot, options.onPoint === undefined ? {} : { onPoint: options.onPoint })
}

async function validateRestoredDatabase(path: string): Promise<void> {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all().flatMap((row) => Object.values(row).map(String))
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`SQLite integrity_check failed: ${integrity.join('; ')}`)
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeyViolations.length > 0) throw new Error(`SQLite foreign_key_check found ${foreignKeyViolations.length} violation(s)`)
  } finally {
    database.close()
  }
}

interface MaterializedBundle {
  header: LocalBackupBundleHeader
  files: number
  bytes: number
  topLevelEntries: string[]
}

interface MaterializedFile {
  path: string
  target: string
  byteLength: number
  sha256: string
}

const RESTORE_TOP_LEVELS = new Set(['data', 'worlds', 'assets', 'packages', 'workshop', 'skills', 'integrations'])
const RESTORE_INCLUDED_VALUES = new Set([
  DATABASE_ARCHIVE_PATH,
  'worlds',
  'assets',
  'packages',
  'workshop',
  'skills',
  'integrations',
  'worlds/*/knowledge/library',
])

function validateBundleHeader(value: LocalBackupBundleHeader): void {
  if (value.format !== 'dsh-cyber-local-backup') throw new Error('不是 DSH Cyber 备份包')
  if (value.schemaVersion !== LOCAL_BACKUP_SCHEMA_VERSION) {
    throw new Error(`不支持的备份包版本：${String(value.schemaVersion)}（当前支持 ${LOCAL_BACKUP_SCHEMA_VERSION}）`)
  }
  if (!Array.isArray(value.included) || !Array.isArray(value.excluded) || typeof value.createdAt !== 'string' || typeof value.notes !== 'string') {
    throw new Error('备份包头部无效')
  }
  if (new Set(value.included).size !== value.included.length) throw new Error('备份包头部包含重复的 included 项')
  for (const item of value.included) {
    if (typeof item !== 'string' || !RESTORE_INCLUDED_VALUES.has(item)) throw new Error(`备份包包含不允许的 included 项：${String(item)}`)
  }
}

function validateBundleEntryShape(value: LocalBackupBundleEntry): void {
  if (typeof value.path !== 'string' || typeof value.dataBase64 !== 'string' ||
    !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 ||
    !Number.isSafeInteger(value.chunkIndex) || value.chunkIndex < 0 ||
    !Number.isSafeInteger(value.chunkCount) || value.chunkCount < 1 ||
    !/^[0-9a-f]{64}$/i.test(value.sha256) || !/^[0-9a-f]{64}$/i.test(value.chunkSha256)) {
    throw new Error(`备份包文件分片无效：${String(value.path)}`)
  }
  if (!isBase64(value.dataBase64)) {
    throw new Error(`备份包文件分片不是有效 Base64：${value.path}`)
  }
  if (value.chunkIndex >= value.chunkCount) throw new Error(`备份包分片索引越界：${value.path}#${value.chunkIndex}`)
}

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  let paddingStart = -1
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 61) {
      if (paddingStart < 0) paddingStart = index
      continue
    }
    if (paddingStart >= 0 || !isBase64Code(code)) return false
  }
  if (paddingStart < 0) return true
  const padding = value.length - paddingStart
  return padding <= 2 && paddingStart >= 2
}

function isBase64Code(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47
}

function assertHeaderIncludesPath(header: LocalBackupBundleHeader, archivePath: string): void {
  const topLevel = topLevelOf(archivePath)
  const included = archivePath === DATABASE_ARCHIVE_PATH ? header.included.includes(DATABASE_ARCHIVE_PATH) : header.included.includes(topLevel)
  if (!included) throw new Error(`备份包文件不在 included 清单中：${archivePath}`)
}

function declaredTopLevels(header: LocalBackupBundleHeader): string[] {
  return [...new Set(header.included.map((item) => {
    if (item === DATABASE_ARCHIVE_PATH) return 'data'
    if (item === 'worlds/*/knowledge/library') return 'worlds'
    return item
  }))]
}

async function materializeBundle(source: string, staging: string): Promise<MaterializedBundle> {
  let header: LocalBackupBundleHeader | undefined
  const topLevelEntries: string[] = []
  const completedFiles: MaterializedFile[] = []
  const seenPaths = new Set<string>()
  let current: { path: string; target: string; digest: ReturnType<typeof createHash>; expected: string; written: number; chunks: number; chunkCount: number; byteLength: number } | undefined
  let bytes = 0

  const finishFile = (): void => {
    if (current === undefined) return
    if (current.chunks !== current.chunkCount) {
      throw new Error(`Backup entry is incomplete: ${current.path}`)
    }
    if (current.written !== current.byteLength) {
      throw new Error(`Backup entry byte count mismatch: ${current.path}`)
    }
    const actual = current.digest.digest('hex')
    if (actual !== current.expected) throw new Error(`Backup entry failed verification: ${current.path}`)
    completedFiles.push({ path: current.path, target: current.target, byteLength: current.byteLength, sha256: current.expected })
    current = undefined
  }

  for await (const line of readGzipLines(source)) {
    if (line.trim().length === 0) continue
    if (header === undefined) {
      header = JSON.parse(line) as LocalBackupBundleHeader
      validateBundleHeader(header)
      for (const topLevel of declaredTopLevels(header)) {
        await mkdir(join(staging, topLevel), { recursive: true })
        if (!topLevelEntries.includes(topLevel)) topLevelEntries.push(topLevel)
      }
      continue
    }
    const entry = JSON.parse(line) as LocalBackupBundleEntry
    // Reject path escapes before validating the remaining record fields so a
    // hostile path can never be normalized or used to influence staging.
    const validatedTarget = typeof entry.path === 'string' ? restoreTargetPath(staging, entry.path) : undefined
    validateBundleEntryShape(entry)
    if (current?.path !== entry.path) {
      finishFile()
      if (seenPaths.has(entry.path)) throw new Error(`Backup entry path is duplicated: ${entry.path}`)
      seenPaths.add(entry.path)
      const target = validatedTarget ?? restoreTargetPath(staging, entry.path)
      assertHeaderIncludesPath(header, entry.path)
      topLevelEntries.push(topLevelOf(entry.path))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, '', { flag: 'wx' })
      current = {
        path: entry.path,
        target,
        digest: createHash('sha256'),
        expected: entry.sha256,
        written: 0,
        chunks: 0,
        chunkCount: entry.chunkCount,
        byteLength: entry.byteLength,
      }
    } else if (current === undefined) {
      throw new Error(`Backup entry has no current file: ${entry.path}`)
    } else if (entry.byteLength !== current.byteLength || entry.sha256 !== current.expected || entry.chunkCount !== current.chunkCount) {
      throw new Error(`Backup entry metadata changed between chunks: ${entry.path}`)
    }
    if (entry.chunkIndex !== current.chunks) {
      throw new Error(`Backup chunks are out of order: ${entry.path}`)
    }
    const chunk = Buffer.from(entry.dataBase64, 'base64')
    if (createHash('sha256').update(chunk).digest('hex') !== entry.chunkSha256) {
      throw new Error(`Backup chunk failed verification: ${entry.path}#${entry.chunkIndex}`)
    }
    const expectedBytes = Math.max(0, Math.min(CHUNK_BYTES, entry.byteLength - entry.chunkIndex * CHUNK_BYTES))
    if (chunk.byteLength !== expectedBytes) {
      throw new Error(`Backup chunk byte count mismatch: ${entry.path}#${entry.chunkIndex}`)
    }
    if (current.written + chunk.byteLength > current.byteLength) {
      throw new Error(`Backup entry exceeds declared byte count: ${entry.path}`)
    }
    await appendFile(current.target, chunk)
    current.digest.update(chunk)
    current.written += chunk.byteLength
    current.chunks += 1
    bytes += chunk.byteLength
  }
  finishFile()
  if (header === undefined) throw new Error('备份包是空的')
  if (!seenPaths.has(DATABASE_ARCHIVE_PATH)) throw new Error('备份包缺少 database.sqlite')
  for (const file of completedFiles) {
    const info = await stat(file.target)
    if (info.size !== file.byteLength || await fileDigest(file.target) !== file.sha256) {
      throw new Error(`Materialized backup file failed verification: ${file.path}`)
    }
  }
  return { header, files: completedFiles.length, bytes, topLevelEntries }
}

/**
 * Read newline-delimited records while retaining stream error propagation.
 * `readline.createInterface(input.pipe(gunzip))` can otherwise leave a source
 * or decompressor error detached from the async iterator on older Node builds.
 */
async function* readGzipLines(source: string): AsyncGenerator<string> {
  const input = createReadStream(source)
  const gunzip = createGunzip()
  input.once('error', (error) => gunzip.destroy(error))
  input.pipe(gunzip)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  try {
    for await (const chunk of gunzip) {
      pending += decoder.write(chunk as Buffer)
      if (pending.length > 16 * 1024 * 1024) throw new Error('备份包单行记录过大')
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        yield line.endsWith('\r') ? line.slice(0, -1) : line
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.end()
    if (pending.length > 0) yield pending
  } finally {
    input.destroy()
    gunzip.destroy()
  }
}

/** Maps an archive path into the staging tree, refusing anything that escapes. */
function restoreTargetPath(staging: string, archivePath: string): string {
  const segments = archivePath.split('/')
  if (archivePath.length === 0 || archivePath.startsWith('/') || archivePath.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  if (process.platform === 'win32' && segments.some(isUnsafeWindowsSegment)) {
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  if (archivePath === 'data/dsh-cyber.sqlite') {
    // The only database spelling in the archive contract is database.sqlite;
    // accepting the target spelling would allow the same file to be listed
    // twice under two identities.
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  const mapped = archivePath === DATABASE_ARCHIVE_PATH ? DATABASE_TARGET_PATH : archivePath
  const normalizedMapped = mapped.replaceAll('\\', '/')
  const mappedSegments = normalizedMapped.split('/')
  if (!RESTORE_TOP_LEVELS.has(mappedSegments[0] ?? '') ||
    (mappedSegments[0] === 'data' && normalizedMapped !== 'data/dsh-cyber.sqlite') ||
    (mappedSegments[0] === 'worlds' && mappedSegments.length >= 3 && mappedSegments[2] === 'cache')) {
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  const target = resolve(join(staging, mapped))
  const inside = relative(resolve(staging), target)
  if (inside.length === 0 || inside.startsWith('..') || inside.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe backup entry path: ${archivePath}`)
  }
  return target
}

function isUnsafeWindowsSegment(segment: string): boolean {
  if (segment.includes(':') || segment.endsWith(' ') || segment.endsWith('.')) return true
  const device = segment.split('.')[0]!.toLocaleUpperCase()
  return new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']).has(device)
}

function topLevelOf(archivePath: string): string {
  const mapped = archivePath === DATABASE_ARCHIVE_PATH ? DATABASE_TARGET_PATH : archivePath
  return mapped.split(/[\\/]/)[0]!
}
