import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import type { CyberPackageManifest, InstalledPackage } from '@dsh-cyber/contracts'
import { isPackageDevelopmentEntry } from './package-authoring.js'

import {
  type PackageActivationReceipt,
  type PackageRuntimeRecoveryReport,
  type PackageRuntimePort,
  PackageVersionContentConflictError,
  type StagedPackage,
  packageManifestDigest,
  validatePackageManifest,
} from './package-manager.js'

const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024

/** Why a package directory does not match the manifest that describes it. */
export type PackageSourceIssueCode =
  | 'undeclared-file'
  | 'missing-file'
  | 'symbolic-link'
  | 'irregular-file'
  | 'file-too-large'
  | 'total-too-large'
  | 'manifest-too-large'
  | 'manifest-mismatch'

/**
 * One inventory mismatch, carrying enough structure for a caller to explain it.
 *
 * The message text is unchanged from the plain `Error` this replaces, and
 * `name` is deliberately left at `Error` so failed installs keep recording the
 * same transaction error code they always did.
 */
export class PackageSourceInventoryError extends Error {
  readonly code: PackageSourceIssueCode
  /** The package-relative path at fault, when the issue names one. */
  readonly path: string | undefined

  constructor(code: PackageSourceIssueCode, message: string, path?: string) {
    super(message)
    this.code = code
    this.path = path
  }
}

export class LocalPackageRuntime implements PackageRuntimePort {
  readonly #root: string

  constructor(root: string) {
    this.#root = resolve(root)
  }

  async recover(installedPackages: readonly InstalledPackage[]): Promise<PackageRuntimeRecoveryReport> {
    const stagingRoot = join(this.#root, '.staging')
    const stagingEntries = await readDirectoryOptional(stagingRoot)
    await rm(stagingRoot, { recursive: true, force: true })
    await mkdir(stagingRoot, { recursive: true })

    const installedByIdentity = new Map<string, InstalledPackage>()
    const activeByPackageId = new Map<string, InstalledPackage>()
    for (const installed of installedPackages) {
      const identity = packageIdentity(installed.packageId, installed.version)
      const previous = installedByIdentity.get(identity)
      if (
        previous !== undefined
        && packageManifestDigest(previous.manifest) !== packageManifestDigest(installed.manifest)
      ) throw new Error(`package_version_content_conflict:${identity}`)
      installedByIdentity.set(identity, installed)
      if (installed.status === 'active') {
        const otherActive = activeByPackageId.get(installed.packageId)
        if (otherActive !== undefined && otherActive.version !== installed.version) {
          throw new Error(`package_runtime_workspace_pointer_conflict:${installed.packageId}`)
        }
        activeByPackageId.set(installed.packageId, installed)
      }
    }

    let verifiedInstalledVersions = 0
    for (const installed of installedByIdentity.values()) {
      const expectedPath = join(this.#root, 'installed', encodeURIComponent(installed.packageId), installed.version)
      if (resolve(installed.installedPath) !== resolve(expectedPath)) {
        throw new Error(`package_installed_path_mismatch:${installed.packageId}@${installed.version}`)
      }
      const manifest = await readInstalledManifest(expectedPath)
      if (manifest === undefined) throw new Error(`package_active_files_missing:${installed.packageId}@${installed.version}`)
      if (packageManifestDigest(manifest) !== packageManifestDigest(installed.manifest)) {
        throw new Error(`package_version_content_conflict:${installed.packageId}@${installed.version}`)
      }
      await verifyInstalledFiles(expectedPath, installed.manifest)
      verifiedInstalledVersions += 1
    }

    for (const packageDirectory of await readDirectoryOptional(join(this.#root, 'installed'))) {
      if (!packageDirectory.isDirectory() || packageDirectory.isSymbolicLink()) {
        throw new Error(`package_runtime_invalid_installed_entry:${packageDirectory.name}`)
      }
      const packageId = decodeURIComponent(packageDirectory.name)
      for (const versionDirectory of await readDirectoryOptional(join(this.#root, 'installed', packageDirectory.name))) {
        if (!versionDirectory.isDirectory() || versionDirectory.isSymbolicLink()) {
          throw new Error(`package_runtime_invalid_version_entry:${packageId}/${versionDirectory.name}`)
        }
        if (!installedByIdentity.has(packageIdentity(packageId, versionDirectory.name))) {
          throw new Error(`package_files_without_database_record:${packageId}@${versionDirectory.name}`)
        }
      }
    }

    let repairedPointers = 0
    let removedDanglingPointers = 0
    const pointerRoot = join(this.#root, 'active')
    const seenPointers = new Set<string>()
    for (const entry of await readDirectoryOptional(pointerRoot)) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
        throw new Error(`package_runtime_invalid_pointer_entry:${entry.name}`)
      }
      const pointerPath = join(pointerRoot, entry.name)
      const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as { packageId?: unknown; version?: unknown; contentDigest?: unknown; installedPath?: unknown }
      const packageId = typeof pointer.packageId === 'string' ? pointer.packageId : ''
      const active = activeByPackageId.get(packageId)
      if (active === undefined) {
        await rm(pointerPath, { force: true })
        removedDanglingPointers += 1
        continue
      }
      seenPointers.add(packageId)
      const expectedPath = join(this.#root, 'installed', encodeURIComponent(active.packageId), active.version)
      const expectedDigest = packageManifestDigest(active.manifest)
      if (pointer.version !== active.version || pointer.contentDigest !== expectedDigest || resolve(String(pointer.installedPath ?? '')) !== resolve(expectedPath)) {
        await writeAtomic(pointerPath, { packageId, version: active.version, contentDigest: expectedDigest, installedPath: expectedPath })
        repairedPointers += 1
      }
    }
    for (const active of activeByPackageId.values()) {
      if (seenPointers.has(active.packageId)) continue
      const installedPath = join(this.#root, 'installed', encodeURIComponent(active.packageId), active.version)
      await writeAtomic(join(pointerRoot, `${encodeURIComponent(active.packageId)}.json`), {
        packageId: active.packageId,
        version: active.version,
        contentDigest: packageManifestDigest(active.manifest),
        installedPath,
      })
      repairedPointers += 1
    }

    return {
      removedStagingEntries: stagingEntries.length,
      repairedPointers,
      removedDanglingPointers,
      verifiedInstalledVersions,
    }
  }

  async stage(manifest: CyberPackageManifest, sourceDirectory: string): Promise<StagedPackage> {
    validatePackageManifest(manifest)
    const sourceRoot = resolve(sourceDirectory)
    const stagingRoot = join(this.#root, '.staging')
    const stagedPath = join(stagingRoot, randomUUID())
    await mkdir(stagedPath, { recursive: true })
    try {
      const sourceRootMetadata = await lstat(sourceRoot)
      if (!sourceRootMetadata.isDirectory() || sourceRootMetadata.isSymbolicLink()) {
        throw new Error('Package source must be a regular directory, not a symbolic link')
      }
      await verifyPackageSourceInventory(sourceRoot, manifest)
      for (const file of manifest.files) {
        let sourcePath = sourceRoot
        for (const segment of file.path.split('/')) {
          sourcePath = resolve(sourcePath, segment)
          if (!sourcePath.startsWith(`${sourceRoot}${sep}`)) {
            throw new Error(`Package file escaped its source directory: ${file.path}`)
          }
          const segmentMetadata = await lstat(sourcePath)
          if (segmentMetadata.isSymbolicLink()) {
            throw new Error(`Package paths cannot contain symbolic links: ${file.path}`)
          }
        }
        const metadata = await lstat(sourcePath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error(`Package file must be a regular file: ${file.path}`)
        }
        if (metadata.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`Package file is too large: ${file.path}`)
        const digest = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
        if (digest !== file.sha256) throw new Error(`Package file integrity mismatch: ${file.path}. 本地修改后运行 pnpm package:prepare <包目录> 更新清单。`)
        const targetPath = join(stagedPath, ...file.path.split('/'))
        await mkdir(dirname(targetPath), { recursive: true })
        await copyFile(sourcePath, targetPath)
      }
      await writeAtomic(join(stagedPath, 'dsh-cyber.package.json'), manifest)
      return { manifest, path: stagedPath }
    } catch (error) {
      await rm(stagedPath, { recursive: true, force: true })
      throw error
    }
  }

  async activate(staged: StagedPackage): Promise<PackageActivationReceipt> {
    const packageRoot = join(this.#root, 'installed', encodeURIComponent(staged.manifest.id))
    const installedPath = join(packageRoot, staged.manifest.version)
    const pointerPath = join(this.#root, 'active', `${encodeURIComponent(staged.manifest.id)}.json`)
    const previousState = await readOptional(pointerPath)
    const contentDigest = packageManifestDigest(staged.manifest)
    await mkdir(packageRoot, { recursive: true })
    let createdInstalledDirectory = false
    try {
      const existingManifest = await readInstalledManifest(installedPath)
      if (existingManifest !== undefined) {
        if (packageManifestDigest(existingManifest) !== contentDigest) {
          throw new PackageVersionContentConflictError(staged.manifest.id, staged.manifest.version)
        }
        await verifyInstalledFiles(installedPath, staged.manifest)
        await rm(staged.path, { recursive: true, force: true })
        await writeAtomic(pointerPath, {
          packageId: staged.manifest.id,
          version: staged.manifest.version,
          contentDigest,
          installedPath,
        })
        return {
          packageId: staged.manifest.id,
          version: staged.manifest.version,
          contentDigest,
          installedPath,
          createdInstalledDirectory: false,
          ...(previousState === undefined ? {} : { previousState }),
        }
      }
      await rename(staged.path, installedPath)
      createdInstalledDirectory = true
      await verifyInstalledFiles(installedPath, staged.manifest)
      await writeAtomic(pointerPath, {
        packageId: staged.manifest.id,
        version: staged.manifest.version,
        contentDigest,
        installedPath,
      })
      return {
        packageId: staged.manifest.id,
        version: staged.manifest.version,
        contentDigest,
        installedPath,
        createdInstalledDirectory: true,
        ...(previousState === undefined ? {} : { previousState }),
      }
    } catch (error) {
      if (createdInstalledDirectory) await rm(installedPath, { recursive: true, force: true })
      throw error
    }
  }

  async rollback(receipt: PackageActivationReceipt): Promise<void> {
    const pointerPath = join(this.#root, 'active', `${encodeURIComponent(receipt.packageId)}.json`)
    if (receipt.previousState === undefined) {
      await rm(pointerPath, { force: true })
    } else {
      await writeAtomicText(pointerPath, receipt.previousState)
    }
    if (receipt.createdInstalledDirectory) {
      await rm(receipt.installedPath, { recursive: true, force: true })
    }
  }

  async discard(staged: StagedPackage): Promise<void> {
    const stagingRoot = join(this.#root, '.staging')
    const stagedPath = resolve(staged.path)
    if (dirname(stagedPath) !== resolve(stagingRoot)) {
      throw new Error('Refusing to discard a path outside package staging')
    }
    await rm(stagedPath, { recursive: true, force: true })
  }
}

async function readInstalledManifest(installedPath: string): Promise<CyberPackageManifest | undefined> {
  const raw = await readOptional(join(installedPath, 'dsh-cyber.package.json'))
  if (raw === undefined) return undefined
  const manifest = JSON.parse(raw) as CyberPackageManifest
  validatePackageManifest(manifest)
  return manifest
}

async function readDirectoryOptional(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function packageIdentity(packageId: string, version: string): string {
  return `${packageId}@${version}`
}

async function verifyInstalledFiles(installedPath: string, manifest: CyberPackageManifest): Promise<void> {
  const root = resolve(installedPath)
  for (const file of manifest.files) {
    const path = resolve(root, ...file.path.split('/'))
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`Activated package file escaped its root: ${file.path}`)
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Activated package file is invalid: ${file.path}`)
    if (metadata.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`Activated package file is too large: ${file.path}`)
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    if (digest !== file.sha256) throw new Error(`Activated package hash mismatch: ${file.path}`)
  }
}

export async function verifyPackageSourceInventory(sourceRoot: string, manifest: CyberPackageManifest): Promise<void> {
  const declared = new Set(manifest.files.map((file) => file.path))
  const discovered = new Set<string>()
  let totalBytes = 0

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      // Local repositories contain editor state and uncommitted credentials.
      // Ignore these source-only files; staging still copies declared files only.
      if (isPackageDevelopmentEntry(entry.name)) continue
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolutePath = resolve(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink() || entry.isSymbolicLink()) {
        throw new PackageSourceInventoryError('symbolic-link', `Package paths cannot contain symbolic links: ${relativePath}`, relativePath)
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!metadata.isFile()) throw new PackageSourceInventoryError('irregular-file', `Package entry must be a regular file: ${relativePath}`, relativePath)
      if (relativePath === 'dsh-cyber.package.json') {
        if (metadata.size > MAX_PACKAGE_MANIFEST_BYTES) throw new PackageSourceInventoryError('manifest-too-large', 'Package source manifest is too large', relativePath)
        const sourceManifest = JSON.parse(await readFile(absolutePath, 'utf8')) as CyberPackageManifest
        validatePackageManifest(sourceManifest)
        if (packageManifestDigest(sourceManifest) !== packageManifestDigest(manifest)) {
          throw new PackageSourceInventoryError('manifest-mismatch', 'Package source manifest does not match the approved manifest', relativePath)
        }
        continue
      }
      if (!declared.has(relativePath)) throw new PackageSourceInventoryError('undeclared-file', `Package source contains an undeclared file: ${relativePath}`, relativePath)
      if (metadata.size > MAX_PACKAGE_FILE_BYTES) throw new PackageSourceInventoryError('file-too-large', `Package file is too large: ${relativePath}`, relativePath)
      totalBytes += metadata.size
      if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) throw new PackageSourceInventoryError('total-too-large', 'Package contents exceed the total size limit')
      discovered.add(relativePath)
    }
  }

  await visit(sourceRoot, '')
  for (const path of declared) {
    if (!discovered.has(path)) throw new PackageSourceInventoryError('missing-file', `Declared package file is missing: ${path}`, path)
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  await writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeAtomicText(filePath: string, value: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filePath)
}
