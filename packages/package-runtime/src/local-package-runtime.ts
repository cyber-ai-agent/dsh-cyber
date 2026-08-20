import { createHash, randomUUID } from 'node:crypto'
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

import type { CyberPackageManifest } from '@dsh-cyber/contracts'

import {
  type PackageActivationReceipt,
  type PackageRuntimePort,
  type StagedPackage,
  packageManifestDigest,
  validatePackageManifest,
} from './package-manager.js'

const MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024

export class LocalPackageRuntime implements PackageRuntimePort {
  readonly #root: string

  constructor(root: string) {
    this.#root = resolve(root)
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
        if (digest !== file.sha256) throw new Error(`Package file integrity mismatch: ${file.path}`)
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
    await mkdir(packageRoot, { recursive: true })
    try {
      await rename(staged.path, installedPath)
      await verifyInstalledFiles(installedPath, staged.manifest)
      await writeAtomic(pointerPath, {
        packageId: staged.manifest.id,
        version: staged.manifest.version,
        installedPath,
      })
      return {
        packageId: staged.manifest.id,
        version: staged.manifest.version,
        installedPath,
        ...(previousState === undefined ? {} : { previousState }),
      }
    } catch (error) {
      await rm(installedPath, { recursive: true, force: true })
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
    await rm(receipt.installedPath, { recursive: true, force: true })
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
      if (entry.name.startsWith('.')) throw new Error(`Hidden package entries are not allowed: ${entry.name}`)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolutePath = resolve(directory, entry.name)
      const metadata = await lstat(absolutePath)
      if (metadata.isSymbolicLink() || entry.isSymbolicLink()) {
        throw new Error(`Package paths cannot contain symbolic links: ${relativePath}`)
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!metadata.isFile()) throw new Error(`Package entry must be a regular file: ${relativePath}`)
      if (relativePath === 'dsh-cyber.package.json') {
        if (metadata.size > MAX_PACKAGE_MANIFEST_BYTES) throw new Error('Package source manifest is too large')
        const sourceManifest = JSON.parse(await readFile(absolutePath, 'utf8')) as CyberPackageManifest
        validatePackageManifest(sourceManifest)
        if (packageManifestDigest(sourceManifest) !== packageManifestDigest(manifest)) {
          throw new Error('Package source manifest does not match the approved manifest')
        }
        continue
      }
      if (!declared.has(relativePath)) throw new Error(`Package source contains an undeclared file: ${relativePath}`)
      if (metadata.size > MAX_PACKAGE_FILE_BYTES) throw new Error(`Package file is too large: ${relativePath}`)
      totalBytes += metadata.size
      if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) throw new Error('Package contents exceed the total size limit')
      discovered.add(relativePath)
    }
  }

  await visit(sourceRoot, '')
  for (const path of declared) {
    if (!discovered.has(path)) throw new Error(`Declared package file is missing: ${path}`)
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
