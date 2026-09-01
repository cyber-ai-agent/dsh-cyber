import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

import type {
  CyberMarketKind,
  CyberMarketPackage,
  CyberPackageManifest,
  InstalledPackage,
} from '@dsh-cyber/contracts'

import { fileStamp, sameFileStamp, type FileStamp } from './file-stamp.js'
import { packageContentDigest, validatePackageManifest } from './package-manager.js'
import { verifyPackageSourceInventory } from './local-package-runtime.js'

const MARKET_DIRECTORIES: Record<CyberMarketKind, string> = {
  theme: 'themes',
  plugin: 'plugins',
  talent: 'talent',
  skin: 'skins',
}

/**
 * Host-owned catalog roots that belong to a single workspace.
 *
 * These roots hold locally produced packages (today: Character Generator
 * output). They are catalog authority, not presentation: a package underneath
 * `container` is only visible to — and only installable by — the workspace that
 * `resolve` maps to its directory. Queries that carry no workspace see none of
 * them, so a caller that forgets to pass a workspace fails closed.
 */
export interface WorkspaceScopedCatalogRoots {
  /** Directory containing every workspace-scoped root. */
  container: string
  /** Resolves the roots owned by one workspace. */
  resolve(workspaceId: string): readonly string[]
}

export interface LocalPackageCatalogOptions {
  trustedAuthorities?: string[]
  /** Additional host-owned catalog roots shared by every workspace. Never treated as verified. */
  additionalRoots?: string[]
  /** Host-owned catalog roots private to one workspace. Never treated as verified. */
  workspaceRoots?: WorkspaceScopedCatalogRoots
}

/** Identifies the workspace a catalog operation is performed on behalf of. */
export interface PackageCatalogScope {
  /** Omitted means "no workspace": workspace-scoped roots stay invisible. */
  workspaceId?: string
}

export interface PackageCatalogQuery extends PackageCatalogScope {
  market?: CyberMarketKind
  query?: string
  installed?: InstalledPackage[]
}

/** A declared marketplace file opened for streaming instead of buffering. */
export interface CatalogFileStream {
  byteLength: number
  body: Readable
}

const PACKAGE_MANIFEST_FILE = 'dsh-cyber.package.json'

interface VerifiedPackage {
  item: CyberMarketPackage
  /** Declared file path -> stamp taken while its SHA-256 was verified. */
  files: Map<string, FileStamp>
  /** Package-relative directory ('' is the package root) -> stamp. */
  directories: Map<string, FileStamp>
  manifest: FileStamp
}

export class LocalPackageCatalog {
  readonly #roots: readonly ManagedCatalogRoot[]
  readonly #trustedAuthorities: Set<string>
  /**
   * Source directory -> the last fully verified scan of that package.
   *
   * A hit is only reused after re-stat'ing the manifest, every declared file
   * and every directory that can hold one. Directory stamps are what keep
   * `verifyPackageSourceInventory` honest: adding, removing or renaming an
   * undeclared entry changes its parent directory's mtime/ctime, which forces
   * a full rescan. Anything that fails to match is re-read and re-hashed.
   */
  readonly #verified = new Map<string, VerifiedPackage>()
  readonly #workspaceRoots: WorkspaceScopedCatalogRoots | undefined
  readonly #workspaceContainer: string | undefined

  constructor(root: string, options: LocalPackageCatalogOptions = {}) {
    const primaryRoot = resolve(root)
    const additionalRoots = [...new Set((options.additionalRoots ?? []).map((item) => resolve(item)))]
      .filter((item) => item !== primaryRoot)
    this.#roots = [
      { path: primaryRoot, primary: true },
      ...additionalRoots.map((path) => ({ path, primary: false })),
    ]
    this.#trustedAuthorities = new Set(options.trustedAuthorities ?? ['DSH Cyber'])
    this.#workspaceRoots = options.workspaceRoots
    this.#workspaceContainer = options.workspaceRoots === undefined ? undefined : resolve(options.workspaceRoots.container)
  }

  /**
   * Drop every memoized scan. Callers that mutate the catalog root out of band
   * (installing or removing a package directory) can force the next read back
   * to a full read-and-hash pass instead of waiting for a stat to differ.
   */
  invalidate(): void {
    this.#verified.clear()
  }

  async list(input: PackageCatalogQuery = {}): Promise<CyberMarketPackage[]> {
    const markets: CyberMarketKind[] = input.market === undefined
      ? ['theme', 'plugin', 'talent', 'skin']
      : [input.market]
    const roots = this.#rootsFor(input.workspaceId)
    const packages = (await Promise.all(markets.flatMap((market) => roots.map((root) => this.#scanMarket(market, root))))).flat()
    const installed = new Map<string, string>()
    for (const item of input.installed ?? []) {
      if (item.status === 'active' && !installed.has(item.packageId)) installed.set(item.packageId, item.version)
    }
    const query = input.query?.trim().toLocaleLowerCase() ?? ''
    return packages
      .filter((item) => query === '' || searchableText(item.manifest).includes(query))
      .map((item) => ({
        ...item,
        ...(installed.get(item.manifest.id) === undefined
          ? {}
          : { installedVersion: installed.get(item.manifest.id)! }),
      }))
      .sort((left, right) => Number(right.verified) - Number(left.verified) || left.manifest.displayName.localeCompare(right.manifest.displayName))
  }

  async find(packageId: string, version?: string, scope: PackageCatalogScope = {}): Promise<CyberMarketPackage | undefined> {
    const items = await this.list(scope)
    return items.find((item) => item.manifest.id === packageId && (version === undefined || item.manifest.version === version))
  }

  /**
   * Throws when `sourceDirectory` sits in a workspace-scoped catalog root that
   * `workspaceId` does not own. Callers that accept a caller-supplied source
   * directory must run this before staging: `find` scoping alone only covers
   * the paths the catalog itself handed out.
   */
  assertInstallSource(workspaceId: string | undefined, sourceDirectory: string): void {
    if (!this.#ownedByOtherWorkspace(workspaceId, sourceDirectory)) return
    throw new Error('Package source directory belongs to another workspace')
  }

  async readDeclaredFile(item: CyberMarketPackage, relativePath: string, scope: PackageCatalogScope = {}): Promise<Buffer> {
    const declared = this.#resolveDeclared(item, relativePath, scope)
    const metadata = await lstat(declared.absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Marketplace file is not a regular file')
    const body = await readFile(declared.absolutePath)
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== declared.sha256) throw new Error('Marketplace file hash mismatch')
    return body
  }

  /**
   * Stream a declared file instead of buffering it.
   *
   * The file is opened first and then fstat'ed through that same handle, so the
   * stamp comparison describes the inode the stream actually reads — a swap
   * between the check and the open cannot slip past it. When the stamp matches
   * the one recorded while this file's SHA-256 was verified, the bytes are
   * streamed straight from disk. Otherwise it falls back to the full verifying
   * read, so an unverified byte is never handed to a caller.
   */
  async openDeclaredFile(item: CyberMarketPackage, relativePath: string, scope: PackageCatalogScope = {}): Promise<CatalogFileStream> {
    const declared = this.#resolveDeclared(item, relativePath, scope)
    const stamp = this.#verified.get(resolve(item.sourceDirectory))?.files.get(relativePath)
    if (stamp !== undefined) {
      const handle = await open(declared.absolutePath, 'r')
      const metadata = await handle.stat()
      if (sameFileStamp(metadata, stamp)) {
        const body = handle.createReadStream()
        body.once('close', () => { void handle.close().catch(() => undefined) })
        return { byteLength: stamp.size, body }
      }
      await handle.close()
    }
    const body = await this.readDeclaredFile(item, relativePath, scope)
    return { byteLength: body.byteLength, body: Readable.from([body]) }
  }

  #resolveDeclared(item: CyberMarketPackage, relativePath: string, scope: PackageCatalogScope): { absolutePath: string; sha256: string } {
    const declared = item.manifest.files.find((file) => file.path === relativePath)
    if (declared === undefined || !safeRelativePath(relativePath)) {
      throw new Error(`Marketplace file is not declared: ${relativePath}`)
    }
    const packageRoot = resolve(item.sourceDirectory)
    // Workspace ownership is checked first and on its own. A deployment whose
    // primary root happens to contain the state root would otherwise satisfy
    // the containment test below and hand one workspace another's bytes.
    if (this.#ownedByOtherWorkspace(scope.workspaceId, packageRoot)) {
      throw new Error('Marketplace package escaped the catalog root')
    }
    if (!this.#rootsFor(scope.workspaceId).some((root) => isPathWithin(root.path, packageRoot))) {
      throw new Error('Marketplace package escaped the catalog root')
    }
    const absolutePath = resolve(packageRoot, ...relativePath.split('/'))
    if (!absolutePath.startsWith(`${packageRoot}${sep}`)) throw new Error('Marketplace file escaped its package root')
    return { absolutePath, sha256: declared.sha256 }
  }

  /**
   * True when `path` lives under the workspace-scoped container but outside the
   * roots `workspaceId` owns — i.e. it is another workspace's private data.
   */
  #ownedByOtherWorkspace(workspaceId: string | undefined, path: string): boolean {
    const container = this.#workspaceContainer
    if (container === undefined) return false
    const candidate = resolve(path)
    if (!isPathWithin(container, candidate)) return false
    return !this.#workspaceScopedRoots(workspaceId).some((root) => isPathWithin(root.path, candidate))
  }

  /** Shared roots plus, when a workspace is named, the roots that workspace owns. */
  #rootsFor(workspaceId: string | undefined): readonly ManagedCatalogRoot[] {
    const scoped = this.#workspaceScopedRoots(workspaceId)
    return scoped.length === 0 ? this.#roots : [...this.#roots, ...scoped]
  }

  #workspaceScopedRoots(workspaceId: string | undefined): readonly ManagedCatalogRoot[] {
    const container = this.#workspaceContainer
    if (this.#workspaceRoots === undefined || container === undefined) return []
    if (workspaceId === undefined || workspaceId === '') return []
    const resolved = [...new Set(this.#workspaceRoots.resolve(workspaceId).map((item) => resolve(item)))]
    // A resolver that escapes its own container would silently re-open the leak
    // this scoping exists to close, so refuse the root instead of trusting it.
    return resolved
      .filter((path) => isPathWithin(container, path) && path !== container)
      .map((path) => ({ path, primary: false }))
  }

  async #scanMarket(market: CyberMarketKind, catalogRoot: ManagedCatalogRoot): Promise<CyberMarketPackage[]> {
    const marketRoot = join(catalogRoot.path, MARKET_DIRECTORIES[market])
    let directories
    try {
      directories = await readdir(marketRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    const results = await Promise.all(directories
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map(async (entry) => this.#readPackage(market, join(marketRoot, entry.name), catalogRoot.primary)))
    return results.filter((item): item is CyberMarketPackage => item !== undefined)
  }

  async #readPackage(market: CyberMarketKind, sourceDirectory: string, primary: boolean): Promise<CyberMarketPackage | undefined> {
    const cacheKey = resolve(sourceDirectory)
    const cached = this.#verified.get(cacheKey)
    if (cached !== undefined && cached.item.market === market && await this.#stillOnDisk(cacheKey, cached)) {
      return cached.item
    }
    this.#verified.delete(cacheKey)
    const manifestPath = join(sourceDirectory, PACKAGE_MANIFEST_FILE)
    try {
      const metadata = await lstat(manifestPath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CyberPackageManifest
      validatePackageManifest(manifest)
      if (!kindMatchesMarket(manifest, market)) return undefined
      await verifyPackageSourceInventory(sourceDirectory, manifest)
      const files = new Map<string, FileStamp>()
      for (const file of manifest.files) {
        const absolutePath = join(sourceDirectory, ...file.path.split('/'))
        const fileMetadata = await lstat(absolutePath)
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) return undefined
        const digest = createHash('sha256').update(await readFile(absolutePath)).digest('hex')
        if (digest !== file.sha256) return undefined
        files.set(file.path, fileStamp(fileMetadata))
      }
      const certification = manifest.certification
      const verified = primary && certification !== undefined &&
        certification.level === 'official' &&
        this.#trustedAuthorities.has(certification.authority) &&
        certification.contentSha256 === packageContentDigest(manifest)
      const item: CyberMarketPackage = { market, manifest, sourceDirectory, verified }
      const directories = await stampDirectories(cacheKey, manifest.files.map((file) => file.path))
      if (directories !== undefined) {
        this.#verified.set(cacheKey, { item, files, directories, manifest: fileStamp(metadata) })
      }
      return item
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return undefined
      return undefined
    }
  }

  async #stillOnDisk(packageRoot: string, cached: VerifiedPackage): Promise<boolean> {
    try {
      if (!sameFileStamp(await lstat(join(packageRoot, PACKAGE_MANIFEST_FILE)), cached.manifest)) return false
      for (const [relative, stamp] of cached.directories) {
        const path = relative === '' ? packageRoot : join(packageRoot, ...relative.split('/'))
        if (!sameFileStamp(await lstat(path), stamp)) return false
      }
      for (const [relative, stamp] of cached.files) {
        if (!sameFileStamp(await lstat(join(packageRoot, ...relative.split('/'))), stamp)) return false
      }
      return true
    } catch {
      return false
    }
  }
}

/** Stamp the package root plus every directory that holds a declared file. */
async function stampDirectories(packageRoot: string, declaredPaths: string[]): Promise<Map<string, FileStamp> | undefined> {
  const relatives = new Set<string>([''])
  for (const declared of declaredPaths) {
    let current = dirname(declared)
    while (current !== '.' && current !== '' && current !== '/') {
      relatives.add(current)
      current = dirname(current)
    }
  }
  const stamps = new Map<string, FileStamp>()
  for (const relative of relatives) {
    const path = relative === '' ? packageRoot : join(packageRoot, ...relative.split('/'))
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined
    stamps.set(relative, fileStamp(metadata, 'directory'))
  }
  return stamps
}

interface ManagedCatalogRoot {
  path: string
  primary: boolean
}

function searchableText(manifest: CyberPackageManifest): string {
  return [manifest.id, manifest.displayName, manifest.summary, manifest.publisher, manifest.kind]
    .join(' ')
    .toLocaleLowerCase()
}

function kindMatchesMarket(manifest: CyberPackageManifest, market: CyberMarketKind): boolean {
  if (market === 'theme') return manifest.kind === 'world-theme'
  if (market === 'talent') return manifest.kind === 'employee-blueprint'
  if (market === 'skin') return manifest.kind === 'skin'
  return manifest.kind === 'plugin' || manifest.kind === 'skill' || manifest.kind === 'asset' || manifest.kind === 'model-provider'
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'))
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isPathWithin(root: string, candidate: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value)
    // Preserve filesystem roots (`/` and `C:\`) so the containment prefix
    // retains its separator.
    if (resolved === sep || /^[A-Za-z]:[\\/]$/u.test(resolved)) return resolved
    return resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved
  }
  const caseInsensitive = process.platform === 'win32'
  const base = normalize(root)
  const target = normalize(candidate)
  const comparableBase = caseInsensitive ? base.toLowerCase() : base
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target
  const prefix = comparableBase.endsWith(sep) ? comparableBase : `${comparableBase}${sep}`
  return comparableTarget === comparableBase || comparableTarget.startsWith(prefix)
}
