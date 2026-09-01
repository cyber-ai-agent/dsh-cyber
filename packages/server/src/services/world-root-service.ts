import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * Marker written into a WorldRoot immediately before its database records are
 * deleted. Its only job is to make a crash mid-delete recoverable: a directory
 * carrying this marker whose world no longer exists in SQLite is unreachable
 * garbage and may be swept, while an unmarked directory is never touched.
 */
const PENDING_DELETE_MARKER = '.pending-delete'

export interface WorldRoot {
  worldId: string
  rootPath: string
  filesPath: string
  /**
   * An empty, host-managed workspace for characters without file access.
   *
   * Pointing them at the real `filesPath` made `world.files.read` inert: with
   * or without the permission the runtime saw the same directory.
   */
  restrictedFilesPath: string
  assetsPath: string
  exportsPath: string
  /** Stable published artifact authority: exports/artifacts/<artifactId>/vN. */
  exportsArtifactsPath: string
  /** World-owned knowledge source root; never aliases the agent files workspace. */
  knowledgePath: string
  /** Durable source files below knowledgePath; SQLite only stores projections. */
  knowledgeLibraryPath: string
  /** Hidden, run-scoped publication request area: files/.dsh/artifacts/<agentRunId>.json. */
  dshPath: string
  dshArtifactsPath: string
  cachePath: string
  sourcePath: string
  packagesPath: string
}

export class WorldRootService {
  readonly #root: string

  constructor(stateRoot: string) {
    this.#root = resolve(stateRoot, 'worlds')
  }

  /** Resolve the only accepted publication manifest location for one run. */
  publicationManifestPath(root: WorldRoot, agentRunId: string): string {
    return join(root.dshArtifactsPath, `${safePathSegment(agentRunId, 'agent run')}.json`)
  }

  /** Resolve the same exact manifest seam for a run-scoped workspace. */
  publicationManifestPathAt(workspacePath: string, agentRunId: string): string {
    return join(workspacePath, '.dsh', 'artifacts', `${safePathSegment(agentRunId, 'agent run')}.json`)
  }

  /** Resolve a version staging location below the published artifact root. */
  artifactVersionPath(root: WorldRoot, artifactId: string, version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Artifact version must be a positive integer')
    return join(root.exportsArtifactsPath, safePathSegment(artifactId, 'artifact'), `v${version}`)
  }

  async ensure(worldId: string): Promise<WorldRoot> {
    await mkdir(this.#root, { recursive: true })
    const managedRoot = await realpath(this.#root)
    const managedInfo = await lstat(this.#root)
    if (managedInfo.isSymbolicLink() || !managedInfo.isDirectory()) throw new Error('Managed world directory is not a real directory')
    // Resolve the child from the canonical managed path. On Windows the
    // configured state root may contain an 8.3 alias (for example
    // `ADMINI~1`) while realpath returns the long form (`Administrator`);
    // mixing the two makes a valid child look like it escaped the sandbox.
    const rootPath = this.#safeWorldRoot(worldId, managedRoot)
    await rejectSymlink(rootPath)
    const filesPath = join(rootPath, 'files')
    const assetsPath = join(rootPath, 'assets')
    const exportsPath = join(rootPath, 'exports')
    const exportsArtifactsPath = join(exportsPath, 'artifacts')
    const knowledgePath = join(rootPath, 'knowledge')
    const knowledgeLibraryPath = join(knowledgePath, 'library')
    // Agent runtimes receive `filesPath` as their workspace root. Keep the
    // publication seam below that same root so a run can write its exact
    // request without escaping the workspace sandbox. WorkspaceFileService
    // hides dot-prefixed entries, so this control directory never appears in
    // the ordinary file browser.
    const dshPath = join(filesPath, '.dsh')
    const dshArtifactsPath = join(dshPath, 'artifacts')
    const cachePath = join(rootPath, 'cache')
    const sourcePath = join(rootPath, 'source')
    const packagesPath = join(sourcePath, 'packages')
    // A character with no world.files.read still needs somewhere to run. It
    // must not be the world's real files directory, and it must stay empty.
    const restrictedPath = join(cachePath, 'restricted-workspace')
    await Promise.all([filesPath, assetsPath, exportsPath, exportsArtifactsPath, knowledgePath, knowledgeLibraryPath, dshPath, dshArtifactsPath, cachePath, sourcePath, packagesPath, restrictedPath].map((path) => mkdir(path, { recursive: true })))
    const resolved = {
      rootPath: await realpath(rootPath),
      filesPath: await realpath(filesPath),
      assetsPath: await realpath(assetsPath),
      exportsPath: await realpath(exportsPath),
      exportsArtifactsPath: await realpath(exportsArtifactsPath),
      knowledgePath: await realpath(knowledgePath),
      knowledgeLibraryPath: await realpath(knowledgeLibraryPath),
      dshPath: await realpath(dshPath),
      dshArtifactsPath: await realpath(dshArtifactsPath),
      cachePath: await realpath(cachePath),
      sourcePath: await realpath(sourcePath),
      packagesPath: await realpath(packagesPath),
      restrictedFilesPath: await realpath(restrictedPath),
    }
    for (const path of Object.values(resolved)) {
      if (!isPathWithin(managedRoot, path)) throw new Error('World path escaped managed data directory')
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('World path is not a real directory')
    }
    return { worldId, ...resolved }
  }

  async remove(worldId: string): Promise<void> {
    await mkdir(this.#root, { recursive: true })
    const managedRoot = await realpath(this.#root)
    const managedInfo = await lstat(this.#root)
    if (managedInfo.isSymbolicLink() || !managedInfo.isDirectory()) throw new Error('Managed world directory is not a real directory')
    const rootPath = this.#safeWorldRoot(worldId, managedRoot)
    if (!isPathWithin(managedRoot, rootPath) || rootPath === managedRoot) {
      throw new Error('Refusing to remove a path outside the managed world directory')
    }
    await rejectSymlink(rootPath)
    await rm(rootPath, { recursive: true, force: true })
  }

  /** Records the intent to delete this world root before SQLite is touched. */
  async markPendingDelete(worldId: string): Promise<void> {
    const root = await this.ensure(worldId)
    await writeFile(join(root.rootPath, PENDING_DELETE_MARKER), `${new Date().toISOString()}\n`, 'utf8')
  }

  /** Withdraws the deletion intent when the delete failed before committing. */
  async clearPendingDelete(worldId: string): Promise<void> {
    const managedRoot = await realpath(this.#root).catch(() => undefined)
    if (managedRoot === undefined) return
    await rm(join(this.#safeWorldRoot(worldId, managedRoot), PENDING_DELETE_MARKER), { force: true })
  }

  /**
   * Finishes deletions that were interrupted between the database commit and
   * the directory removal.
   *
   * Only a root that was explicitly marked *and* has no surviving world record
   * is removed. An unmarked orphan is left alone on purpose: a state directory
   * paired with a fresh or restored database must never be silently emptied.
   */
  async sweepPendingDeletes(survivingWorldIds: Iterable<string>): Promise<string[]> {
    const survivors = new Set(survivingWorldIds)
    const entries = await readdir(this.#root, { withFileTypes: true }).catch(() => [])
    const swept: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const worldId = decodeURIComponent(entry.name)
      if (survivors.has(worldId)) continue
      const marker = join(this.#root, entry.name, PENDING_DELETE_MARKER)
      if (await lstat(marker).then((info) => info.isFile(), () => false)) {
        await this.remove(worldId)
        swept.push(worldId)
      }
    }
    return swept
  }

  #safeWorldRoot(worldId: string, baseRoot = this.#root): string {
    const safeId = encodeURIComponent(worldId)
    const rootPath = resolve(baseRoot, safeId)
    if (rootPath === baseRoot || !rootPath.startsWith(`${baseRoot}${sep}`)) {
      throw new Error('World root escaped managed data directory')
    }
    return rootPath
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('World root cannot be a symbolic link')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function isPathWithin(parent: string, candidate: string): boolean {
  const normalize = (value: string) => value.endsWith(sep) ? value.slice(0, -1) : value
  const base = normalize(parent).toLowerCase()
  const target = normalize(candidate).toLowerCase()
  return target === base || target.startsWith(`${base}${sep}`)
}

function safePathSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`Invalid ${label} path segment`)
  return value
}
