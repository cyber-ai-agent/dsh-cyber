import { mkdir, realpath } from 'node:fs/promises'
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
    const safeId = encodeURIComponent(worldId)
    const rootPath = resolve(this.#root, safeId)
    if (rootPath !== this.#root && !rootPath.startsWith(`${this.#root}${sep}`)) throw new Error('World root escaped managed data directory')
    const filesPath = join(rootPath, 'files')
    const assetsPath = join(rootPath, 'assets')
    const exportsPath = join(rootPath, 'exports')
    const cachePath = join(rootPath, 'cache')
    await Promise.all([filesPath, assetsPath, exportsPath, cachePath].map((path) => mkdir(path, { recursive: true })))
    return { worldId, rootPath: await realpath(rootPath), filesPath: await realpath(filesPath), assetsPath: await realpath(assetsPath), exportsPath: await realpath(exportsPath), cachePath: await realpath(cachePath) }
  }
}
