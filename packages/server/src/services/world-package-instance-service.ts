import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import type { InstalledPackage, WorldPackageInstance } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { InstalledPackageVerificationCache } from '../installed-package-runtime.js'
import type { WorldRoot, WorldRootService } from './world-root-service.js'
import { ServiceError } from './service-error.js'

export interface InstantiateWorldPackageInput {
  worldId: string
  packageId: string
  version: string
  actorId?: string
}

/** Materializes immutable package-library content inside one world's authority boundary. */
export class WorldPackageInstanceService {
  /**
   * Removes staging trees a crash left behind.
   *
   * `instantiate` renames a staging directory into place before the database
   * row exists, so an interruption between the two leaves a `.<id>.staging`
   * tree that nothing references and that a backup would faithfully copy.
   */
  async sweepOrphanedStaging(worldId: string): Promise<number> {
    let removed = 0
    try {
      const root = await this.roots.ensure(worldId)
      for (const entry of await readdir(root.packagesPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('.') || !entry.name.endsWith('.staging')) continue
        await rm(join(root.packagesPath, entry.name), { recursive: true, force: true })
        removed += 1
      }
    } catch {
      // A world whose package root does not exist has nothing to sweep.
    }
    return removed
  }

  readonly #verification = new InstalledPackageVerificationCache()

  constructor(
    readonly store: SqliteStore,
    readonly roots: WorldRootService,
  ) {}

  async instantiate(input: InstantiateWorldPackageInput): Promise<WorldPackageInstance> {
    const world = this.store.getWorld(input.worldId)
    if (world === undefined) throw new ServiceError('not-found', 'world_not_found', '世界不存在')
    const installed = this.store.getInstalledPackage(world.workspaceId, input.packageId, input.version)
    if (installed === undefined) throw new ServiceError('conflict', 'package_library_version_unavailable', '本地包库中没有这个版本，请先完成安装')
    await this.#verification.verifyPackage(installed)
    const contentDigest = packageContentDigest(installed)
    const existing = this.store.listWorldPackageInstances(world.id, 'active')
      .find((item) => item.packageId === installed.packageId)
    if (existing !== undefined) {
      if (existing.packageVersion === installed.version && existing.contentDigest === contentDigest) return existing
      throw new ServiceError('conflict', 'world_package_update_required', '当前世界正在使用这个包的另一个版本，请先预览更新并停用旧实例')
    }

    const root = await this.roots.ensure(world.id)
    const id = randomUUID()
    const instanceRoot = checkedChild(root.packagesPath, id)
    const temporaryRoot = checkedChild(root.packagesPath, `.${id}.staging`)
    await rejectExisting(instanceRoot)
    await rejectExisting(temporaryRoot)
    try {
      const origin = resolve(temporaryRoot, 'origin')
      const overrides = resolve(temporaryRoot, 'overrides')
      await mkdir(origin, { recursive: true })
      await mkdir(overrides, { recursive: true })
      for (const file of installed.manifest.files) {
        const source = await verifiedSourceFile(installed, file.path)
        const destination = checkedChild(origin, file.path)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(source, destination)
      }
      const manifest = {
        schemaVersion: 1,
        id,
        worldId: world.id,
        source: {
          packageId: installed.packageId,
          version: installed.version,
          kind: installed.kind,
          contentDigest,
        },
        createdAt: new Date().toISOString(),
      }
      await writeFile(resolve(temporaryRoot, 'instance.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporaryRoot, instanceRoot)
      const originPath = portableRelative(root, resolve(instanceRoot, 'origin'))
      const overridesPath = portableRelative(root, resolve(instanceRoot, 'overrides'))
      try {
        return this.store.createWorldPackageInstance({
          id, workspaceId: world.workspaceId, worldId: world.id,
          packageId: installed.packageId, packageVersion: installed.version,
          packageKind: installed.kind, contentDigest, originPath, overridesPath,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        })
      } catch (error) {
        await removeExactInstance(root, instanceRoot)
        throw error
      }
    } catch (error) {
      await removeExactInstance(root, temporaryRoot)
      throw error
    }
  }

  async listRuntimePackages(worldId: string): Promise<InstalledPackage[]> {
    const world = this.store.getWorld(worldId)
    if (world === undefined) throw new ServiceError('not-found', 'world_not_found', '世界不存在')
    const root = await this.roots.ensure(worldId)
    return this.store.listWorldPackageInstances(worldId, 'active').map((instance) => {
      const installed = this.store.getInstalledPackage(
        instance.workspaceId, instance.packageId, instance.packageVersion,
      )
      if (installed === undefined) throw new Error(`Package library source is missing for world instance ${instance.id}`)
      if (installed.kind !== instance.packageKind) throw new Error(`Package kind changed for world instance ${instance.id}`)
      if (packageContentDigest(installed) !== instance.contentDigest) {
        throw new Error(`Package library metadata changed for world instance ${instance.id}`)
      }
      return { ...installed, status: 'active', installedPath: checkedChild(root.rootPath, instance.originPath) }
    })
  }

  async compensateRolledBackWorld(worldId: string): Promise<void> {
    if (this.store.getWorld(worldId) !== undefined) {
      throw new Error('Refusing to remove package data for an existing world')
    }
    await this.roots.remove(worldId)
  }
}

function packageContentDigest(installed: InstalledPackage): string {
  return createHash('sha256').update(stableJson(installed.manifest)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function verifiedSourceFile(installed: InstalledPackage, path: string): Promise<string> {
  if (!safeRelativePath(path)) throw new Error(`Unsafe package file path: ${path}`)
  const root = resolve(installed.installedPath)
  const source = checkedChild(root, path)
  let current = root
  for (const segment of path.split('/')) {
    current = resolve(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in packages: ${path}`)
  }
  const info = await lstat(source)
  if (!info.isFile()) throw new Error(`Package file is unavailable: ${path}`)
  return source
}

function safeRelativePath(path: string): boolean {
  return Boolean(path) && !path.includes('\\') && !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function checkedChild(parent: string, child: string): string {
  const root = resolve(parent)
  const target = resolve(root, child)
  if (target === root || !target.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)) {
    throw new Error('World package path escaped its managed root')
  }
  return target
}

function portableRelative(root: WorldRoot, path: string): string {
  const value = relative(root.rootPath, path).replace(/\\/g, '/')
  if (!safeRelativePath(value)) throw new Error('World package path cannot be persisted safely')
  return value
}

async function rejectExisting(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new Error('World package instance path already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function removeExactInstance(root: WorldRoot, path: string): Promise<void> {
  const expectedParent = resolve(root.packagesPath)
  const target = resolve(path)
  if (target === expectedParent || !target.toLowerCase().startsWith(`${expectedParent.toLowerCase()}${sep}`)) {
    throw new Error('Refusing to clean a path outside the world package directory')
  }
  await rm(target, { recursive: true, force: true })
}
