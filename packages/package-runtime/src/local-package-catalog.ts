import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type {
  CyberMarketKind,
  CyberMarketPackage,
  CyberPackageManifest,
  InstalledPackage,
} from '@dsh-cyber/contracts'

import { packageContentDigest, validatePackageManifest } from './package-manager.js'
import { verifyPackageSourceInventory } from './local-package-runtime.js'

const MARKET_DIRECTORIES: Record<CyberMarketKind, string> = {
  theme: 'themes',
  plugin: 'plugins',
  talent: 'talent',
  skin: 'skins',
}

export interface LocalPackageCatalogOptions {
  trustedAuthorities?: string[]
  /** Additional host-owned catalog roots. These are never treated as verified. */
  additionalRoots?: string[]
}

export interface PackageCatalogQuery {
  market?: CyberMarketKind
  query?: string
  installed?: InstalledPackage[]
}

export class LocalPackageCatalog {
  readonly #roots: readonly ManagedCatalogRoot[]
  readonly #trustedAuthorities: Set<string>

  constructor(root: string, options: LocalPackageCatalogOptions = {}) {
    const primaryRoot = resolve(root)
    const additionalRoots = [...new Set((options.additionalRoots ?? []).map((item) => resolve(item)))]
      .filter((item) => item !== primaryRoot)
    this.#roots = [
      { path: primaryRoot, primary: true },
      ...additionalRoots.map((path) => ({ path, primary: false })),
    ]
    this.#trustedAuthorities = new Set(options.trustedAuthorities ?? ['DSH Cyber'])
  }

  async list(input: PackageCatalogQuery = {}): Promise<CyberMarketPackage[]> {
    const markets: CyberMarketKind[] = input.market === undefined
      ? ['theme', 'plugin', 'talent', 'skin']
      : [input.market]
    const packages = (await Promise.all(markets.flatMap((market) => this.#roots.map((root) => this.#scanMarket(market, root))))).flat()
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

  async find(packageId: string, version?: string): Promise<CyberMarketPackage | undefined> {
    const items = await this.list()
    return items.find((item) => item.manifest.id === packageId && (version === undefined || item.manifest.version === version))
  }

  async readDeclaredFile(item: CyberMarketPackage, relativePath: string): Promise<Buffer> {
    const declared = item.manifest.files.find((file) => file.path === relativePath)
    if (declared === undefined || !safeRelativePath(relativePath)) {
      throw new Error(`Marketplace file is not declared: ${relativePath}`)
    }
    const packageRoot = resolve(item.sourceDirectory)
    if (!this.#roots.some((root) => isPathWithin(root.path, packageRoot))) {
      throw new Error('Marketplace package escaped the catalog root')
    }
    const absolutePath = resolve(packageRoot, ...relativePath.split('/'))
    if (!absolutePath.startsWith(`${packageRoot}${sep}`)) throw new Error('Marketplace file escaped its package root')
    const metadata = await lstat(absolutePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Marketplace file is not a regular file')
    const body = await readFile(absolutePath)
    const digest = createHash('sha256').update(body).digest('hex')
    if (digest !== declared.sha256) throw new Error('Marketplace file hash mismatch')
    return body
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
    const manifestPath = join(sourceDirectory, 'dsh-cyber.package.json')
    try {
      const metadata = await lstat(manifestPath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CyberPackageManifest
      validatePackageManifest(manifest)
      if (!kindMatchesMarket(manifest, market)) return undefined
      await verifyPackageSourceInventory(sourceDirectory, manifest)
      for (const file of manifest.files) {
        const absolutePath = join(sourceDirectory, ...file.path.split('/'))
        const fileMetadata = await lstat(absolutePath)
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) return undefined
        const digest = createHash('sha256').update(await readFile(absolutePath)).digest('hex')
        if (digest !== file.sha256) return undefined
      }
      const certification = manifest.certification
      const verified = primary && certification !== undefined &&
        certification.level === 'official' &&
        this.#trustedAuthorities.has(certification.authority) &&
        certification.contentSha256 === packageContentDigest(manifest)
      return { market, manifest, sourceDirectory, verified }
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return undefined
      return undefined
    }
  }
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
