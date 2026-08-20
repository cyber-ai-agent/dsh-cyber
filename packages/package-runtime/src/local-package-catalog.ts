import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
}

export interface LocalPackageCatalogOptions {
  trustedAuthorities?: string[]
}

export interface PackageCatalogQuery {
  market?: CyberMarketKind
  query?: string
  installed?: InstalledPackage[]
}

export class LocalPackageCatalog {
  readonly #root: string
  readonly #trustedAuthorities: Set<string>

  constructor(root: string, options: LocalPackageCatalogOptions = {}) {
    this.#root = resolve(root)
    this.#trustedAuthorities = new Set(options.trustedAuthorities ?? ['DSH Cyber'])
  }

  async list(input: PackageCatalogQuery = {}): Promise<CyberMarketPackage[]> {
    const markets: CyberMarketKind[] = input.market === undefined
      ? ['theme', 'plugin', 'talent']
      : [input.market]
    const packages = (await Promise.all(markets.map((market) => this.#scanMarket(market)))).flat()
    const installed = new Map((input.installed ?? []).map((item) => [item.packageId, item.version]))
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

  async #scanMarket(market: CyberMarketKind): Promise<CyberMarketPackage[]> {
    const marketRoot = join(this.#root, MARKET_DIRECTORIES[market])
    let directories
    try {
      directories = await readdir(marketRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
    const results = await Promise.all(directories
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map(async (entry) => this.#readPackage(market, join(marketRoot, entry.name))))
    return results.filter((item): item is CyberMarketPackage => item !== undefined)
  }

  async #readPackage(market: CyberMarketKind, sourceDirectory: string): Promise<CyberMarketPackage | undefined> {
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
      const verified = certification !== undefined &&
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

function searchableText(manifest: CyberPackageManifest): string {
  return [manifest.id, manifest.displayName, manifest.summary, manifest.publisher, manifest.kind]
    .join(' ')
    .toLocaleLowerCase()
}

function kindMatchesMarket(manifest: CyberPackageManifest, market: CyberMarketKind): boolean {
  if (market === 'theme') return manifest.kind === 'world-theme'
  if (market === 'talent') return manifest.kind === 'employee-blueprint' || manifest.kind === 'skill'
  return manifest.kind === 'plugin' || manifest.kind === 'asset' || manifest.kind === 'model-provider'
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
