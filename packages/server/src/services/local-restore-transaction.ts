import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const JOURNAL_SCHEMA_VERSION = 1
const TRANSACTIONS_DIRECTORY = '.restore-transactions'
const JOURNAL_FILE = 'journal.json'

const ALLOWED_TOP_LEVELS = new Set(['data', 'worlds', 'assets', 'packages', 'workshop', 'skills', 'integrations'])

export type LocalRestoreTransactionPhase =
  | 'prepared'
  | 'swapping'
  | 'preserving-excluded'
  | 'validated'
  | 'committed'
  | 'rolled-back'

export interface LocalRestoreTransactionRoot {
  /** The top-level stateRoot entry represented by this operation. */
  topLevel: string
  /** All paths are persisted so recovery does not need to reconstruct intent. */
  livePath: string
  stagingPath: string
  rollbackPath: string
  /** Whether the live path existed before this transaction started. */
  existed: boolean
}

export interface LocalRestoreTransactionJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  transactionId: string
  stateRoot: string
  bundlePath: string
  transactionPath: string
  stagingPath: string
  rollbackPath: string
  createdAt: string
  updatedAt: string
  phase: LocalRestoreTransactionPhase
  /** Immutable initial roots; recovery infers completed renames from disk. */
  roots: LocalRestoreTransactionRoot[]
}

export interface LocalRestoreTransaction {
  journalPath: string
  journal: LocalRestoreTransactionJournal
}

export interface LocalRestoreTransactionHookContext {
  transactionId: string
  phase: LocalRestoreTransactionPhase | 'recovery'
  topLevel?: string
}

export type LocalRestoreTransactionPoint =
  | 'after-root-backup'
  | 'after-root-install'
  | 'after-excluded-preserve'
  | 'before-recovery-rollback'
  | 'after-recovery-live-remove'
  | 'after-recovery-root-restore'

export interface LocalRestoreTransactionOptions {
  onPoint?: ((point: LocalRestoreTransactionPoint, context: LocalRestoreTransactionHookContext) => void | Promise<void>) | undefined
}

/**
 * Move a fully materialized staging tree into a durable restore transaction.
 * No live state is touched until the prepared journal is durable.
 */
export async function prepareLocalRestoreTransaction(input: {
  stateRoot: string
  bundlePath: string
  stagingPath: string
  topLevelEntries: readonly string[]
  createdAt?: string
}): Promise<LocalRestoreTransaction> {
  const stateRoot = await canonicalStateRoot(input.stateRoot)
  const topLevels = [...new Set(input.topLevelEntries)].sort()
  for (const topLevel of topLevels) assertAllowedTopLevel(topLevel)

  const transactionsRoot = join(stateRoot, TRANSACTIONS_DIRECTORY)
  const transactionId = randomUUID()
  const transactionPath = join(transactionsRoot, transactionId)
  const stagingPath = join(transactionPath, 'stage')
  const rollbackPath = join(transactionPath, 'rollback')
  const journalPath = join(transactionPath, JOURNAL_FILE)
  if (await pathExists(transactionsRoot) && !await isRealDirectory(transactionsRoot)) {
    throw new Error(`Restore transaction root is not a real directory: ${transactionsRoot}`)
  }
  await mkdir(transactionPath, { recursive: true })
  await mkdir(rollbackPath, { recursive: true })

  try {
    await rename(input.stagingPath, stagingPath)
    const roots: LocalRestoreTransactionRoot[] = []
    for (const topLevel of topLevels) {
      roots.push({
        topLevel,
        livePath: join(stateRoot, topLevel),
        stagingPath: join(stagingPath, topLevel),
        rollbackPath: join(rollbackPath, topLevel),
        existed: await pathExists(join(stateRoot, topLevel)),
      })
    }
    const now = input.createdAt ?? new Date().toISOString()
    const journal: LocalRestoreTransactionJournal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId,
      stateRoot,
      bundlePath: resolve(input.bundlePath),
      transactionPath,
      stagingPath,
      rollbackPath,
      createdAt: now,
      updatedAt: now,
      phase: 'prepared',
      roots,
    }
    await writeJournal(journalPath, journal)
    return { journalPath, journal }
  } catch (error) {
    await rm(transactionPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function setLocalRestoreTransactionPhase(
  transaction: LocalRestoreTransaction,
  phase: LocalRestoreTransactionPhase,
): Promise<LocalRestoreTransaction> {
  const journal = await readJournal(transaction.journalPath)
  const updated: LocalRestoreTransactionJournal = {
    ...journal,
    phase,
    updatedAt: new Date().toISOString(),
  }
  await writeJournal(transaction.journalPath, updated)
  return { journalPath: transaction.journalPath, journal: updated }
}

/**
 * Swap every included root using rename-only operations. The old copy remains
 * available until a committed marker is written, so a crash can be rolled
 * back even if it happened after a rename and before the next journal write.
 */
export async function swapLocalRestoreTransaction(
  transaction: LocalRestoreTransaction,
  options: LocalRestoreTransactionOptions = {},
): Promise<LocalRestoreTransaction> {
  let current = await setLocalRestoreTransactionPhase(transaction, 'swapping')
  for (const root of current.journal.roots) {
    if (await pathExists(root.livePath)) {
      await rename(root.livePath, root.rollbackPath)
      await options.onPoint?.('after-root-backup', {
        transactionId: current.journal.transactionId,
        phase: 'swapping',
        topLevel: root.topLevel,
      })
    }
    if (!await pathExists(root.stagingPath)) {
      throw new Error(`Restore staging root is missing: ${root.topLevel}`)
    }
    await mkdir(dirname(root.livePath), { recursive: true })
    await rename(root.stagingPath, root.livePath)
    await options.onPoint?.('after-root-install', {
      transactionId: current.journal.transactionId,
      phase: 'swapping',
      topLevel: root.topLevel,
    })
  }
  return current
}

/**
 * A world's `cache` directory is deliberately absent from the bundle. Copy it from the
 * rollback generation after the durable world tree has been installed, while
 * retaining the rollback tree for recovery until commit.
 */
export async function preserveExcludedWorldCaches(
  transaction: LocalRestoreTransaction,
  options: LocalRestoreTransactionOptions = {},
): Promise<LocalRestoreTransaction> {
  const current = await setLocalRestoreTransactionPhase(transaction, 'preserving-excluded')
  const worlds = current.journal.roots.find((root) => root.topLevel === 'worlds')
  if (worlds !== undefined && await pathExists(worlds.rollbackPath) && await isDirectory(worlds.rollbackPath)) {
    await copyCacheTrees(worlds.rollbackPath, worlds.livePath)
  }
  await options.onPoint?.('after-excluded-preserve', {
    transactionId: current.journal.transactionId,
    phase: 'preserving-excluded',
  })
  return current
}

export async function markLocalRestoreTransactionCommitted(
  transaction: LocalRestoreTransaction,
): Promise<LocalRestoreTransaction> {
  return setLocalRestoreTransactionPhase(transaction, 'committed')
}

/** Cleanup is intentionally separate from commit; old copies survive until the marker is durable. */
export async function cleanupLocalRestoreTransaction(transaction: LocalRestoreTransaction): Promise<void> {
  const journal = await readJournal(transaction.journalPath)
  if (journal.phase !== 'committed' && journal.phase !== 'rolled-back') {
    throw new Error(`Cannot clean an uncommitted restore transaction: ${journal.transactionId}`)
  }
  await rm(journal.rollbackPath, { recursive: true, force: true })
  await rm(journal.stagingPath, { recursive: true, force: true })
  await rm(transaction.journalPath, { force: true })
  await rmdir(journal.transactionPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  })
  await rmdir(dirname(journal.transactionPath)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
  })
}

/**
 * Recover transactions while the caller holds the state-root lease. This
 * function deliberately does not acquire the lease itself.
 */
export async function recoverLocalRestoreTransactions(
  stateRoot: string,
  options: LocalRestoreTransactionOptions = {},
): Promise<void> {
  const root = await canonicalStateRoot(stateRoot)
  const transactionsRoot = join(root, TRANSACTIONS_DIRECTORY)
  if (!await pathExists(transactionsRoot)) return
  if (!await isRealDirectory(transactionsRoot)) throw new Error(`Restore transaction root is not a real directory: ${transactionsRoot}`)
  const entries = await readdir(transactionsRoot, { withFileTypes: true })
  const transactions: LocalRestoreTransaction[] = []
  const orphanTransactionPaths: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const transactionPath = join(transactionsRoot, entry.name)
    const journalPath = join(transactionPath, JOURNAL_FILE)
    if (!await pathExists(journalPath)) {
      // A process can die after moving the temporary stage into the private
      // transaction directory but before the prepared journal is published.
      // No live path has been touched at that point, so the orphan is safe to
      // discard. Journals are the only authority for mutations.
      orphanTransactionPaths.push(transactionPath)
      continue
    }
    const journal = await readJournal(journalPath)
    if (journal.stateRoot !== root || journal.transactionPath !== transactionPath) {
      throw new Error(`Restore journal belongs to another state root: ${journalPath}`)
    }
    transactions.push({ journalPath, journal })
  }

  // Parse and validate every journal before removing any journal-less orphan;
  // a malformed journal must fail closed without any destructive cleanup.
  for (const transactionPath of orphanTransactionPaths) {
    await rm(transactionPath, { recursive: true, force: true })
  }

  for (const transaction of transactions) {
    if (transaction.journal.phase === 'committed') {
      await cleanupLocalRestoreTransaction(transaction)
      continue
    }
    await options.onPoint?.('before-recovery-rollback', {
      transactionId: transaction.journal.transactionId,
      phase: 'recovery',
    })
    await rollbackLocalRestoreTransaction(transaction, options)
  }
}

async function rollbackLocalRestoreTransaction(
  transaction: LocalRestoreTransaction,
  options: LocalRestoreTransactionOptions,
): Promise<void> {
  const current = { journalPath: transaction.journalPath, journal: await readJournal(transaction.journalPath) }
  // Reverse order avoids exposing a partially restored dependency tree if a
  // caller inspects the root while recovery is still running.
  for (const root of [...current.journal.roots].reverse()) {
    const rollbackExists = await pathExists(root.rollbackPath)
    const liveExists = await pathExists(root.livePath)
    if (rollbackExists) {
      if (liveExists) {
        await rm(root.livePath, { recursive: true, force: true })
        await options.onPoint?.('after-recovery-live-remove', {
          transactionId: current.journal.transactionId,
          phase: 'recovery',
          topLevel: root.topLevel,
        })
      }
      await mkdir(dirname(root.livePath), { recursive: true })
      await rename(root.rollbackPath, root.livePath)
      await options.onPoint?.('after-recovery-root-restore', {
        transactionId: current.journal.transactionId,
        phase: 'recovery',
        topLevel: root.topLevel,
      })
      continue
    }
    if (root.existed && !liveExists) {
      // The initial root existed, but neither the live nor rescue copy does.
      // Do not silently declare this recovered: the only safe action is to
      // retain the journal and let the caller surface the damaged transaction.
      throw new Error(`Restore recovery lost the initial root: ${root.topLevel}`)
    }
    if (!root.existed && liveExists) {
      await rm(root.livePath, { recursive: true, force: true })
      await options.onPoint?.('after-recovery-live-remove', {
        transactionId: current.journal.transactionId,
        phase: 'recovery',
        topLevel: root.topLevel,
      })
    }
  }
  // Mark rolled-back only after every root has been restored. If this write or
  // the preceding operations fail, cleanup is intentionally skipped and the
  // rescue copies remain available for the next recovery attempt.
  const rolledBack = await setLocalRestoreTransactionPhase(current, 'rolled-back')
  await cleanupLocalRestoreTransaction(rolledBack)
}

async function copyCacheTrees(source: string, target: string): Promise<boolean> {
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isDirectory()) return false
  let copied = false
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'cache') {
        await copyTree(from, to)
        copied = true
      } else {
        copied = (await copyCacheTrees(from, join(target, entry.name))) || copied
      }
    }
  }
  return copied
}

async function copyTree(source: string, target: string): Promise<void> {
  const info = await lstat(source)
  if (!info.isDirectory()) return
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to)
    } else if (entry.isFile()) {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    }
  }
}

async function readJournal(path: string): Promise<LocalRestoreTransactionJournal> {
  const content = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`Restore journal is not valid JSON: ${path}`, { cause: error })
  }
  if (!isJournal(value)) throw new Error(`Restore journal is invalid: ${path}`)
  return value
}

async function writeJournal(path: string, journal: LocalRestoreTransactionJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function isJournal(value: unknown): value is LocalRestoreTransactionJournal {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== JOURNAL_SCHEMA_VERSION || typeof record.transactionId !== 'string' || typeof record.stateRoot !== 'string' || typeof record.bundlePath !== 'string' || typeof record.transactionPath !== 'string' || typeof record.stagingPath !== 'string' || typeof record.rollbackPath !== 'string' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false
  if (!/^[0-9a-f-]{36}$/i.test(record.transactionId)) return false
  if (!['prepared', 'swapping', 'preserving-excluded', 'validated', 'committed', 'rolled-back'].includes(String(record.phase))) return false
  if (!Array.isArray(record.roots) || record.roots.length === 0) return false
  const stateRoot = resolve(record.stateRoot)
  const transactionPath = resolve(record.transactionPath)
  const expectedTransactionsRoot = resolve(join(stateRoot, TRANSACTIONS_DIRECTORY))
  if (!isInside(expectedTransactionsRoot, transactionPath) || transactionPath.split(/[\\/]/).at(-1) !== record.transactionId) return false
  if (resolve(record.stagingPath) !== resolve(join(transactionPath, 'stage'))) return false
  if (resolve(record.rollbackPath) !== resolve(join(transactionPath, 'rollback'))) return false
  const seen = new Set<string>()
  for (const item of record.roots) {
    if (typeof item !== 'object' || item === null) return false
    const root = item as Record<string, unknown>
    if (typeof root.topLevel !== 'string' || typeof root.livePath !== 'string' || typeof root.stagingPath !== 'string' || typeof root.rollbackPath !== 'string' || typeof root.existed !== 'boolean') return false
    if (seen.has(root.topLevel)) return false
    seen.add(root.topLevel)
    try { assertAllowedTopLevel(root.topLevel) } catch { return false }
    if (resolve(root.livePath) !== resolve(join(stateRoot, root.topLevel))) return false
    if (resolve(root.stagingPath) !== resolve(join(record.stagingPath, root.topLevel))) return false
    if (resolve(root.rollbackPath) !== resolve(join(record.rollbackPath, root.topLevel))) return false
  }
  return true
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith('/') || parent.endsWith('\\') ? parent.slice(0, -1) : parent
  const normalizedChild = child.endsWith('/') || child.endsWith('\\') ? child.slice(0, -1) : child
  const parentForComparison = process.platform === 'win32' ? normalizedParent.toLocaleLowerCase() : normalizedParent
  const childForComparison = process.platform === 'win32' ? normalizedChild.toLocaleLowerCase() : normalizedChild
  return childForComparison !== parentForComparison && childForComparison.startsWith(`${parentForComparison}${process.platform === 'win32' ? '\\' : '/'}`)
}

function assertAllowedTopLevel(topLevel: string): void {
  if (!ALLOWED_TOP_LEVELS.has(topLevel)) throw new Error(`Unsafe restore top-level path: ${topLevel}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function canonicalStateRoot(stateRoot: string): Promise<string> {
  return realpath(resolve(stateRoot))
}
