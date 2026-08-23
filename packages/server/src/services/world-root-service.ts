import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface WorldRoot {
  worldId: string
  rootPath: string
  filesPath: string
  assetsPath: string
  exportsPath: string
  cachePath: string
}

export class WorldRootService {
  readonly #root: string

  constructor(stateRoot: string) {
    this.#root = resolve(stateRoot, 'worlds')
  }

  async ensure(worldId: string): Promise<WorldRoot> {
    await mkdir(this.#root, { recursive: true })
    const managedRoot = await realpath(this.#root)
    const managedInfo = await lstat(this.#root)
    if (managedInfo.isSymbolicLink() || !managedInfo.isDirectory()) throw new Error('Managed world directory is not a real directory')
    const rootPath = this.#safeWorldRoot(worldId)
    await rejectSymlink(rootPath)
    const filesPath = join(rootPath, 'files')
    const assetsPath = join(rootPath, 'assets')
    const exportsPath = join(rootPath, 'exports')
    const cachePath = join(rootPath, 'cache')
    await Promise.all([filesPath, assetsPath, exportsPath, cachePath].map((path) => mkdir(path, { recursive: true })))
    const resolved = {
      rootPath: await realpath(rootPath),
      filesPath: await realpath(filesPath),
      assetsPath: await realpath(assetsPath),
      exportsPath: await realpath(exportsPath),
      cachePath: await realpath(cachePath),
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
    const rootPath = this.#safeWorldRoot(worldId)
    if (!isPathWithin(managedRoot, rootPath) || rootPath === managedRoot) {
      throw new Error('Refusing to remove a path outside the managed world directory')
    }
    await rejectSymlink(rootPath)
    await rm(rootPath, { recursive: true, force: true })
  }

  #safeWorldRoot(worldId: string): string {
    const safeId = encodeURIComponent(worldId)
    const rootPath = resolve(this.#root, safeId)
    if (rootPath === this.#root || !rootPath.startsWith(`${this.#root}${sep}`)) {
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

function isPathWithin(parent: string, candidate: string): boolean {
  const normalize = (value: string) => value.endsWith(sep) ? value.slice(0, -1) : value
  const base = normalize(parent).toLowerCase()
  const target = normalize(candidate).toLowerCase()
  return target === base || target.startsWith(`${base}${sep}`)
}
