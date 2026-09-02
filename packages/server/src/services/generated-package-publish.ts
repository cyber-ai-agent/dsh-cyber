import { lstat, mkdir, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'

import { HttpError } from '../http/errors.js'
import { assertAvatarImage, type AvatarMediaType } from './avatar-image-guard.js'

/**
 * Host boundary every generator publish walks.
 *
 * The Character, World, Skin and Plugin Generators all write packages into a
 * workspace-scoped generated marketplace root. The functions here are the
 * shared containment rules for that write: every path component below the
 * host root is `lstat`ed so a planted symlink cannot redirect a publish, a
 * package directory is always a direct child of its market root, and an
 * existing directory is never removed or replaced.
 */

/** Official talent packages whose previews the generators may reuse as avatars. */
export const BUILTIN_AVATAR_PACKAGE_IDS = [
  'official-archivist',
  'official-observatory-xenobiologist',
  'official-studio-visual-director',
  'official-tavern-storyweaver',
] as const
export const DEFAULT_AVATAR_PACKAGE_ID = 'official-archivist'

export interface GeneratedPackagePaths {
  stagingDirectory: string
  installedDirectory: string
}

/**
 * Create the market root below the marketplace root and return the staging and
 * final directories for `packageId`. Nothing is written for the package itself.
 */
export async function prepareGeneratedPackagePaths(
  containmentRoot: string,
  marketplaceRoot: string,
  marketSegment: 'talent' | 'themes' | 'skins' | 'plugins',
  packageId: string,
  stagingToken: string,
): Promise<GeneratedPackagePaths> {
  const marketRoot = join(marketplaceRoot, marketSegment)
  // Create and verify the target tree so a hostile or broken layout answers
  // with a publish failure instead of an internal error.
  await mkdirContained(containmentRoot, marketplaceRoot)
  await mkdirContained(containmentRoot, marketRoot)
  const stagingDirectory = join(marketRoot, `.${packageId}.staging-${stagingToken}`)
  const installedDirectory = join(marketRoot, packageId)
  assertDirectChild(marketRoot, stagingDirectory)
  assertDirectChild(marketRoot, installedDirectory)
  await rejectExisting(installedDirectory)
  return { stagingDirectory, installedDirectory }
}

/**
 * Move a compiled staging directory into place.
 *
 * Re-verifies immediately before the rename: compiling the package widened the
 * window in which the tree could have been swapped underneath us, and rename
 * would otherwise follow a link or replace a path outside the root.
 */
export async function commitGeneratedPackage(containmentRoot: string, paths: GeneratedPackagePaths): Promise<void> {
  await assertContainedDirectory(containmentRoot, paths.stagingDirectory)
  await assertContainedDirectory(containmentRoot, dirname(paths.installedDirectory))
  await rejectExisting(paths.installedDirectory)
  await rename(paths.stagingDirectory, paths.installedDirectory)
}

/**
 * Read one official talent package's preview bitmap. The declared path only
 * narrows the candidates; the stored bytes decide the media type.
 */
export async function loadBuiltinAvatarPreview(
  packageCatalog: LocalPackageCatalog,
  packageId: string,
): Promise<{ bytes: Buffer; mimeType: AvatarMediaType }> {
  if (!(BUILTIN_AVATAR_PACKAGE_IDS as readonly string[]).includes(packageId)) {
    throw new HttpError(422, 'character_avatar_not_allowed', '只能使用指定的官方角色预览。')
  }
  const item = await packageCatalog.find(packageId)
  if (item === undefined || item.market !== 'talent' || !item.verified || item.manifest.kind !== 'employee-blueprint') {
    throw new HttpError(422, 'character_avatar_not_found', '官方角色预览不可用。')
  }
  const preview = item.manifest.files.find((file) => /\.(?:png|jpe?g|webp)$/iu.test(file.path))
  if (preview === undefined) throw new HttpError(422, 'character_avatar_missing', '官方角色预览缺失。')
  const bytes = await packageCatalog.readDeclaredFile(item, preview.path)
  return { bytes, mimeType: assertAvatarImage(bytes) }
}

/**
 * Assert that `target` is a real directory reachable from `root` without
 * crossing a symlink. Every component below the root is `lstat`ed in turn, so a
 * link planted at any depth — the target itself included — fails instead of
 * silently redirecting the write.
 */
export async function assertContainedDirectory(root: string, target: string): Promise<void> {
  for (const path of containedPathChain(root, target)) await assertRealDirectory(path)
}

/**
 * Create `target` below `root`, verifying each level before descending into it.
 *
 * `mkdir -p` follows a symlinked component and would materialize the tree at
 * the link's destination before any check could object, so each segment is
 * inspected first and a link anywhere on the way aborts before anything outside
 * the root is created.
 */
export async function mkdirContained(root: string, target: string): Promise<void> {
  await assertRealDirectory(resolve(root))
  for (const path of containedPathChain(root, target)) {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing === undefined) await mkdir(path, { recursive: true, mode: 0o700 })
    // Re-check after creating: the segment may have been raced into a link.
    await assertRealDirectory(path)
  }
}

/**
 * Every path from `root` down to `target`, exclusive of the root itself.
 *
 * Components at or above the root are never inspected: the root is host
 * configuration, and platforms whose state paths are themselves symlinks
 * (`/var` on macOS) would otherwise never pass.
 */
function containedPathChain(root: string, target: string): string[] {
  const resolvedRoot = resolve(root)
  const relativePath = relative(resolvedRoot, resolve(target))
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Generated marketplace path escaped its root')
  }
  const chain: string[] = []
  let current = resolvedRoot
  for (const segment of relativePath === '' ? [] : relativePath.split(sep)) {
    current = join(current, segment)
    chain.push(current)
  }
  return chain
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Generated marketplace path crosses a symlink')
  }
}

/** Guard the package directory names against ever gaining a path segment. */
export function assertDirectChild(parent: string, child: string): void {
  if (dirname(resolve(child)) !== resolve(parent)) {
    throw new Error('Generated package path is not a direct child of its market root')
  }
}

export async function rejectExisting(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new Error('Generated package path already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
