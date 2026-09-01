import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { WorkspaceScopedCatalogRoots } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

/**
 * On-disk layout for Character Generator output.
 *
 *   <stateRoot>/workshop/character-generator/workspaces/<segment>/marketplace/talent/<packageId>
 *
 * The `<segment>` is derived from the workspace id and is the ownership record:
 * the catalog only exposes a generated package to the workspace whose segment
 * contains it, so ownership travels with the bytes through backup/restore and
 * through a manual copy of the state root.
 *
 * Character Generator V1 shipped these packages to a single global
 * `character-generator/marketplace` with no workspace segment, which made every
 * generated character visible and installable from every workspace. That path
 * is now legacy: `migrateLegacyCharacterGeneratorMarketplace` adopts whatever it
 * finds there into one workspace on startup, and nothing ever writes to it
 * again.
 */
const WORKSHOP_SEGMENTS = ['workshop', 'character-generator'] as const
const WORKSPACES_SEGMENT = 'workspaces'
const MARKETPLACE_SEGMENT = 'marketplace'
const TALENT_SEGMENT = 'talent'
const SLUG_LENGTH = 32
const DIGEST_LENGTH = 16

/** `<stateRoot>/workshop/character-generator`. */
export function characterGeneratorRoot(stateRoot: string): string {
  return join(resolve(stateRoot), ...WORKSHOP_SEGMENTS)
}

/** Directory holding every workspace-scoped generated marketplace. */
export function characterGeneratorWorkspaceContainer(stateRoot: string): string {
  return join(characterGeneratorRoot(stateRoot), WORKSPACES_SEGMENT)
}

/** The pre-isolation global marketplace. Read once at startup, then removed. */
export function legacyCharacterGeneratorMarketplaceRoot(stateRoot: string): string {
  return join(characterGeneratorRoot(stateRoot), MARKETPLACE_SEGMENT)
}

/** Generated marketplace root owned by exactly one workspace. */
export function characterGeneratorMarketplaceRoot(stateRoot: string, workspaceId: string): string {
  const container = characterGeneratorWorkspaceContainer(stateRoot)
  const root = join(container, workspaceDirectorySegment(workspaceId), MARKETPLACE_SEGMENT)
  // Defence in depth: the encoding below cannot emit a separator or a dot
  // segment, so a root outside the container means the encoder regressed.
  if (!root.startsWith(`${container}${sep}`)) throw new Error('Character generator workspace root escaped its container')
  return root
}

/**
 * Path-safe, collision-free directory name for a workspace id.
 *
 * The readable slug is only a debugging aid; the SHA-256 suffix carries the
 * identity. Two different workspace ids therefore never share a directory even
 * when they differ solely by case (macOS and Windows) or solely by characters
 * the slug drops.
 */
export function workspaceDirectorySegment(workspaceId: string): string {
  const trimmed = workspaceId.trim()
  if (trimmed === '') throw new Error('Workspace id is required')
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, SLUG_LENGTH).replace(/-+$/u, '')
  const digest = createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, DIGEST_LENGTH)
  const segment = slug === '' ? `ws-${digest}` : `${slug}-${digest}`
  // Traversal and separators are structurally impossible above; assert it so a
  // future edit to the slug rules cannot quietly reintroduce them.
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(segment)) throw new Error('Workspace directory segment is not path-safe')
  return segment
}

/**
 * Moves any pre-isolation generated packages into `ownerWorkspaceId`.
 *
 * V1 recorded no workspace on these packages, so their real origin is
 * unknowable. Adopting them into one workspace keeps the user's work (nothing
 * is deleted) while restoring the boundary; leaving them globally readable
 * would preserve exactly the defect being fixed. The caller passes the oldest
 * workspace, which is the one that existed while V1 was writing.
 *
 * Returns the ids of the packages that moved. A package whose id already exists
 * in the target is left in place rather than overwritten.
 */
export async function migrateLegacyCharacterGeneratorMarketplace(
  stateRoot: string,
  ownerWorkspaceId: string,
): Promise<string[]> {
  const legacyRoot = legacyCharacterGeneratorMarketplaceRoot(stateRoot)
  const legacyTalent = join(legacyRoot, TALENT_SEGMENT)
  let entries
  try {
    entries = await readdir(legacyTalent, { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
  const candidates = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
  const targetTalent = join(characterGeneratorMarketplaceRoot(stateRoot, ownerWorkspaceId), TALENT_SEGMENT)
  await mkdir(targetTalent, { recursive: true, mode: 0o700 })
  const moved: string[] = []
  for (const entry of candidates) {
    const target = join(targetTalent, entry.name)
    if (await pathExists(target)) continue
    await rename(join(legacyTalent, entry.name), target)
    moved.push(entry.name)
  }
  // Abandoned staging directories from an interrupted V1 publish are not user
  // work; drop them so the legacy root can retire.
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('.')) {
      await rm(join(legacyTalent, entry.name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
  await removeIfEmpty(legacyTalent)
  await removeIfEmpty(legacyRoot)
  return moved
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  await rmdir(path).catch(() => undefined)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export interface CharacterGeneratorMarketplace {
  /** Catalog roots the package catalog resolves per query. */
  workspaceRoots: WorkspaceScopedCatalogRoots
  /** Where the generator writes a workspace's newly published characters. */
  resolveMarketplaceRoot(workspaceId: string): string
  /** Host boundary every generated write must stay inside. */
  containmentRoot: string
}

/**
 * Prepares the workspace-scoped generated marketplace and retires the V1 global
 * one. Call once during composition, before the package catalog is built.
 */
export async function composeCharacterGeneratorMarketplace(
  stateRoot: string,
  store: Pick<SqliteStore, 'listWorkspaces'>,
): Promise<CharacterGeneratorMarketplace> {
  const owner = store.listWorkspaces()[0]
  if (owner !== undefined) await migrateLegacyCharacterGeneratorMarketplace(stateRoot, owner.id)
  return {
    workspaceRoots: {
      container: characterGeneratorWorkspaceContainer(stateRoot),
      resolve: (workspaceId) => [characterGeneratorMarketplaceRoot(stateRoot, workspaceId)],
    },
    resolveMarketplaceRoot: (workspaceId) => characterGeneratorMarketplaceRoot(stateRoot, workspaceId),
    containmentRoot: stateRoot,
  }
}
