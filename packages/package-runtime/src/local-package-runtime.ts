import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'

import {
  type PackageActivationReceipt,
  type PackageRuntimePort,
  type StagedPackage,
  validatePackageManifest,
} from './package-manager.js'

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
      for (const file of manifest.files) {
        const sourcePath = join(sourceRoot, ...file.path.split('/'))
        const metadata = await lstat(sourcePath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw new Error(`Package file must be a regular file: ${file.path}`)
        }
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
