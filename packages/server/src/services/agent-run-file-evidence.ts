import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { isPathWithin, type WorldRoot } from './world-root-service.js'

/**
 * What the Host itself observed about one AgentRun's file writes.
 *
 * The Artifact Center used to learn about produced files in two ways, and
 * neither is evidence: a manifest the model writes (a claim), and a scan of the
 * files whose modification time falls inside the run window (a guess that
 * cannot separate two runs executing at once).  This module adds the only thing
 * the Host can actually testify to - it censuses the workspace immediately
 * before the run is handed to the runtime and again immediately after it comes
 * back, and records the difference together with the other run brackets that
 * were open at the same instant.
 *
 * What a record proves: a regular file with exactly this content and this
 * modification time was present at the end of this run's bracket and was not
 * present, or held different bytes, at its start; and whether any other
 * bracketed run of the same World covered that same instant.
 *
 * What it does not prove: that the model's own process performed the write.  An
 * owner upload, an external editor or (under 完全访问) any other program writing
 * into the World during the same bracket is indistinguishable from the agent.
 *
 * What it says nothing about: anything that happened after the bracket closed.
 * A record is a statement about one past instant, and publication comes later,
 * so a reader of these files has to re-check the bytes against the record
 * before presenting a record as proof of what it is publishing.
 */

export interface AgentRunFileEvidenceLimits {
  /** Directory entries one census may visit before it reports truncation. */
  maxEntries: number
  maxDepth: number
  /** Changed files hashed into one record. */
  maxChangedFiles: number
  /** Total bytes hashed into one record. */
  maxHashBytes: number
  /** How long a finished bracket stays comparable for concurrency checks. */
  retentionMs: number
  /** Modification-time slack for coarse filesystem timestamps. */
  writeToleranceMs: number
}

export const AGENT_RUN_FILE_EVIDENCE_LIMITS: AgentRunFileEvidenceLimits = {
  maxEntries: 4_000,
  maxDepth: 16,
  maxChangedFiles: 256,
  maxHashBytes: 64 * 1024 * 1024,
  retentionMs: 30 * 60_000,
  writeToleranceMs: 1_000,
}

/** Directory names the census and the publication scan both ignore. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'cache', '.dsh'])

export interface AgentRunFileObservation {
  /** POSIX path relative to the run workspace. */
  path: string
  change: 'created' | 'modified'
  byteLength: number
  /** Empty when the file was too large or too numerous to hash in this record. */
  sha256: string
  modifiedAtMs: number
  /** No other bracketed run of this World covered the write instant. */
  exclusive: boolean
  concurrentRunIds: string[]
}

export interface AgentRunFileEvidenceRecord {
  schemaVersion: 1
  worldId: string
  agentRunId: string
  startedAtMs: number
  completedAtMs: number
  files: AgentRunFileObservation[]
  /** A census hit its bound; the record is a sample, never a complete census. */
  truncated: boolean
  scannedEntries: number
  entryLimit: number
}

interface CensusEntry { byteLength: number; modifiedAtMs: number; inode: number }
interface Census { entries: Map<string, CensusEntry>; scanned: number; truncated: boolean }

export interface AgentRunBracket {
  worldId: string
  agentRunId: string
  workspacePath: string
  startedAtMs: number
  baseline: Map<string, CensusEntry>
  truncated: boolean
  scannedEntries: number
}

/** The seam the character runtime uses to bracket one forwarded turn. */
export interface AgentRunFileEvidencePort {
  begin(input: { worldId: string; agentRunId: string; workspacePath: string }): Promise<AgentRunBracket | undefined>
  complete(bracket: AgentRunBracket | undefined): Promise<AgentRunFileEvidenceRecord | undefined>
}

/** The seam the Artifact service uses when it decides what a run produced. */
export interface AgentRunFileEvidenceReader {
  read(worldId: string, agentRunId: string): Promise<AgentRunFileEvidenceRecord | undefined>
  readPublications(worldId: string, agentRunId: string): Promise<AgentRunPublicationRecord | undefined>
  recordPublications(input: AgentRunPublicationRecordInput): Promise<void>
}

/** One publication grade decision, kept beside the observation that produced it. */
export interface AgentRunPublicationEntry {
  artifactId: string
  version: number
  sourceRelativePath: string
  grade: 'host-observed' | 'shared-window' | 'manifest-declared' | 'unproven-window'
  observedAtMs?: number
  /**
   * Whether the published bytes were still the observed bytes at publication
   * time. Absent only when no observation matched at all; `host-observed`
   * requires it to be true.
   */
  contentMatchesObservation?: boolean
  concurrentRunIds?: string[]
  scanTruncated?: boolean
}

export interface AgentRunPublicationRecord {
  schemaVersion: 1
  worldId: string
  agentRunId: string
  entries: AgentRunPublicationEntry[]
}

export interface AgentRunPublicationRecordInput {
  worldId: string
  agentRunId: string
  entries: AgentRunPublicationEntry[]
}

export interface AgentRunFileEvidenceOptions {
  roots: { ensure(worldId: string): Promise<WorldRoot> }
  limits?: Partial<AgentRunFileEvidenceLimits>
  clock?: () => number
}

interface RunWindow { agentRunId: string; startedAtMs: number; endedAtMs?: number }

export class AgentRunFileEvidenceService implements AgentRunFileEvidencePort, AgentRunFileEvidenceReader {
  readonly #roots: { ensure(worldId: string): Promise<WorldRoot> }
  readonly #limits: AgentRunFileEvidenceLimits
  readonly #clock: () => number
  /** Open and recently finished brackets per World, used for exclusivity. */
  readonly #windows = new Map<string, RunWindow[]>()
  /** Latest end time already dropped from a World's window list. */
  readonly #prunedThroughMs = new Map<string, number>()

  constructor(options: AgentRunFileEvidenceOptions) {
    this.#roots = options.roots
    this.#limits = { ...AGENT_RUN_FILE_EVIDENCE_LIMITS, ...options.limits }
    this.#clock = options.clock ?? (() => Date.now())
  }

  /**
   * Census the workspace and open a bracket.  It never throws into the turn: a
   * run whose evidence cannot be collected keeps working, it just cannot prove
   * anything afterwards.
   */
  async begin(input: { worldId: string; agentRunId: string; workspacePath: string }): Promise<AgentRunBracket | undefined> {
    try {
      const root = await this.#roots.ensure(input.worldId)
      // The caller may still name the workspace through the operator's own
      // symlink (a state root below `/var` on macOS); the World root is already
      // canonical, so a lexical path would silently never match it.
      const workspacePath = await realpath(input.workspacePath)
      if (!isBracketableWorkspace(root, workspacePath)) return undefined
      safeRunSegment(input.agentRunId)
      const startedAtMs = this.#clock()
      const census = await censusOf(workspacePath, this.#limits)
      this.#windowsFor(input.worldId).push({ agentRunId: input.agentRunId, startedAtMs })
      return {
        worldId: input.worldId,
        agentRunId: input.agentRunId,
        workspacePath,
        startedAtMs,
        baseline: census.entries,
        truncated: census.truncated,
        scannedEntries: census.scanned,
      }
    } catch {
      return undefined
    }
  }

  /** Close the bracket, compute the delta and persist the Host-owned record. */
  async complete(bracket: AgentRunBracket | undefined): Promise<AgentRunFileEvidenceRecord | undefined> {
    if (bracket === undefined) return undefined
    const completedAtMs = this.#clock()
    const window = this.#windowsFor(bracket.worldId).find((candidate) => candidate.agentRunId === bracket.agentRunId && candidate.endedAtMs === undefined)
    if (window !== undefined) window.endedAtMs = completedAtMs
    try {
      const census = await censusOf(bracket.workspacePath, this.#limits)
      const truncated = bracket.truncated || census.truncated
      const changed = changedEntries(bracket.baseline, census.entries)
      const files: AgentRunFileObservation[] = []
      let hashedBytes = 0
      // A bracket that was already dropped from the window list could have
      // covered these writes, so no exclusivity claim survives that.
      const comparable = (this.#prunedThroughMs.get(bracket.worldId) ?? 0) < bracket.startedAtMs
      for (const entry of changed.slice(0, this.#limits.maxChangedFiles)) {
        const absolutePath = join(bracket.workspacePath, ...entry.path.split('/'))
        const hashable = entry.byteLength + hashedBytes <= this.#limits.maxHashBytes
        const sha256 = hashable ? await hashFile(absolutePath) : ''
        if (hashable) hashedBytes += entry.byteLength
        const concurrentRunIds = this.#concurrentRunIds(bracket, entry.modifiedAtMs, completedAtMs)
        const insideOwnWindow = entry.modifiedAtMs >= bracket.startedAtMs - this.#limits.writeToleranceMs
          && entry.modifiedAtMs <= completedAtMs + this.#limits.writeToleranceMs
        files.push({
          path: entry.path,
          change: entry.change,
          byteLength: entry.byteLength,
          sha256,
          modifiedAtMs: entry.modifiedAtMs,
          exclusive: comparable && concurrentRunIds.length === 0 && insideOwnWindow && sha256 !== '',
          concurrentRunIds,
        })
      }
      const record: AgentRunFileEvidenceRecord = {
        schemaVersion: 1,
        worldId: bracket.worldId,
        agentRunId: bracket.agentRunId,
        startedAtMs: bracket.startedAtMs,
        completedAtMs,
        files,
        truncated: truncated || changed.length > this.#limits.maxChangedFiles,
        scannedEntries: Math.max(bracket.scannedEntries, census.scanned),
        entryLimit: this.#limits.maxEntries,
      }
      await this.#write(bracket.worldId, `${safeRunSegment(bracket.agentRunId)}.json`, record)
      return record
    } catch {
      return undefined
    } finally {
      this.#prune(bracket.worldId, completedAtMs)
    }
  }

  async read(worldId: string, agentRunId: string): Promise<AgentRunFileEvidenceRecord | undefined> {
    const value = await this.#read(worldId, `${safeRunSegment(agentRunId)}.json`)
    if (value === undefined || value.schemaVersion !== 1 || !Array.isArray(value.files)) return undefined
    return value as unknown as AgentRunFileEvidenceRecord
  }

  async readPublications(worldId: string, agentRunId: string): Promise<AgentRunPublicationRecord | undefined> {
    const value = await this.#read(worldId, `${safeRunSegment(agentRunId)}.published.json`)
    if (value === undefined || value.schemaVersion !== 1 || !Array.isArray(value.entries)) return undefined
    return value as unknown as AgentRunPublicationRecord
  }

  /**
   * Merge grade decisions for one run.  Re-publishing after a crash rewrites
   * the same artifact/version key instead of appending a second decision.
   */
  async recordPublications(input: AgentRunPublicationRecordInput): Promise<void> {
    if (input.entries.length === 0) return
    const existing = await this.readPublications(input.worldId, input.agentRunId)
    const merged = new Map<string, AgentRunPublicationEntry>()
    for (const entry of existing?.entries ?? []) merged.set(`${entry.artifactId} ${entry.version}`, entry)
    for (const entry of input.entries) merged.set(`${entry.artifactId} ${entry.version}`, entry)
    await this.#write(input.worldId, `${safeRunSegment(input.agentRunId)}.published.json`, {
      schemaVersion: 1,
      worldId: input.worldId,
      agentRunId: input.agentRunId,
      entries: [...merged.values()],
    })
  }

  #concurrentRunIds(bracket: AgentRunBracket, modifiedAtMs: number, completedAtMs: number): string[] {
    const tolerance = this.#limits.writeToleranceMs
    return this.#windowsFor(bracket.worldId)
      .filter((candidate) => candidate.agentRunId !== bracket.agentRunId)
      .filter((candidate) => modifiedAtMs >= candidate.startedAtMs - tolerance
        && modifiedAtMs <= (candidate.endedAtMs ?? completedAtMs) + tolerance)
      .map((candidate) => candidate.agentRunId)
  }

  #windowsFor(worldId: string): RunWindow[] {
    const existing = this.#windows.get(worldId)
    if (existing !== undefined) return existing
    const created: RunWindow[] = []
    this.#windows.set(worldId, created)
    return created
  }

  #prune(worldId: string, nowMs: number): void {
    const windows = this.#windowsFor(worldId)
    const cutoff = nowMs - this.#limits.retentionMs
    let prunedThrough = this.#prunedThroughMs.get(worldId) ?? 0
    const kept = windows.filter((candidate) => {
      if (candidate.endedAtMs === undefined || candidate.endedAtMs >= cutoff) return true
      prunedThrough = Math.max(prunedThrough, candidate.endedAtMs)
      return false
    })
    this.#prunedThroughMs.set(worldId, prunedThrough)
    this.#windows.set(worldId, kept)
  }

  async #directory(worldId: string): Promise<string> {
    const root = await this.#roots.ensure(worldId)
    // Host-owned, outside `files/`, so a workspace-write run cannot forge it,
    // and inside the World root, so it is backed up and deleted with the World.
    const directory = join(root.rootPath, 'runs', 'evidence')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  async #write(worldId: string, fileName: string, value: unknown): Promise<void> {
    const directory = await this.#directory(worldId)
    const target = join(directory, fileName)
    const staging = `${target}.tmp-${randomUUID()}`
    try {
      await writeFile(staging, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #read(worldId: string, fileName: string): Promise<Record<string, unknown> | undefined> {
    try {
      const directory = await this.#directory(worldId)
      const body = await readFile(join(directory, fileName), 'utf8')
      const parsed: unknown = JSON.parse(body)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
}

/** A run pointed at the empty restricted workspace can never write anything. */
function isBracketableWorkspace(root: WorldRoot, workspacePath: string): boolean {
  const candidate = resolve(workspacePath)
  if (isPathWithin(root.restrictedFilesPath, candidate)) return false
  return isPathWithin(root.filesPath, candidate)
}

interface ChangedEntry { path: string; change: 'created' | 'modified'; byteLength: number; modifiedAtMs: number }

function changedEntries(baseline: Map<string, CensusEntry>, current: Map<string, CensusEntry>): ChangedEntry[] {
  const changed: ChangedEntry[] = []
  for (const [path, entry] of current) {
    const before = baseline.get(path)
    if (before === undefined) {
      changed.push({ path, change: 'created', byteLength: entry.byteLength, modifiedAtMs: entry.modifiedAtMs })
      continue
    }
    if (before.byteLength !== entry.byteLength || before.modifiedAtMs !== entry.modifiedAtMs || before.inode !== entry.inode) {
      changed.push({ path, change: 'modified', byteLength: entry.byteLength, modifiedAtMs: entry.modifiedAtMs })
    }
  }
  return changed.sort((left, right) => left.path.localeCompare(right.path))
}

/**
 * Bounded breadth-first census of regular files.  It stops at `maxEntries` and
 * says so instead of silently returning a partial picture; symlinks are
 * recorded as nothing at all, because they are never publishable.
 */
async function censusOf(workspacePath: string, limits: AgentRunFileEvidenceLimits): Promise<Census> {
  const entries = new Map<string, CensusEntry>()
  const queue: Array<{ absolutePath: string; relativePath: string; depth: number }> = [
    { absolutePath: workspacePath, relativePath: '', depth: 0 },
  ]
  let scanned = 0
  let truncated = false
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > limits.maxDepth) { truncated = true; continue }
    let children
    try {
      children = await readdir(current.absolutePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (IGNORED_SEGMENTS.has(child.name.toLowerCase())) continue
      if (child.isSymbolicLink()) continue
      scanned += 1
      if (scanned > limits.maxEntries) { truncated = true; break }
      const absolutePath = join(current.absolutePath, child.name)
      const relativePath = current.relativePath === '' ? child.name : `${current.relativePath}/${child.name}`
      if (child.isDirectory()) {
        queue.push({ absolutePath, relativePath, depth: current.depth + 1 })
        continue
      }
      if (!child.isFile()) continue
      try {
        const info = await lstat(absolutePath)
        entries.set(relativePath, { byteLength: info.size, modifiedAtMs: info.mtimeMs, inode: info.ino })
      } catch {
        continue
      }
    }
    if (truncated) break
  }
  return { entries, scanned: Math.min(scanned, limits.maxEntries), truncated }
}

async function hashFile(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return ''
  }
}

function safeRunSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes(sep)) {
    throw new Error('Invalid agent run id for evidence record')
  }
  return value
}
