import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'

import type { CyberMarketPackage, InstalledPackage } from '@dsh-cyber/contracts'

import {
  AVATAR_BASE_PACK_CAPABILITY,
  AVATAR_BASE_PACK_MANIFEST_PATH,
  assertAvatarBaseVrmEnvelope,
  isAvatarPackPackage,
  parseInstalledAvatarBasePackManifest,
  type AvatarBaseModel,
  type InstalledAvatarBasePackManifest,
} from '../avatar-base-pack-manifest.js'
import { InstalledPackageVerificationCache } from '../installed-package-runtime.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'
import { ServiceError } from './service-error.js'

export const OFFICIAL_AVATAR_BASE_PACK_ID = 'official-avatar-base-v1'

export interface BrowserAvatarBasePackManifest {
  schemaVersion: 1
  id: string
  version: string
  displayName: string
  license: string
  publisher: string
  quality: 'preview' | 'production'
  bases: Array<{ baseModel: AvatarBaseModel; assetUrl: string; cacheKey: string }>
  parts: InstalledAvatarBasePackManifest['parts']
  materialSlots: InstalledAvatarBasePackManifest['materialSlots']
}

export interface AvatarBasePackCatalogPort {
  find(packageId: string, version?: string): Promise<CyberMarketPackage | undefined>
  readDeclaredFile(item: CyberMarketPackage, relativePath: string): Promise<Buffer>
  openDeclaredFile(item: CyberMarketPackage, relativePath: string): Promise<{ byteLength: number; body: Readable }>
}

/** A Base VRM handed to HTTP as a stream, so a 6+ MiB body is never buffered. */
export interface AvatarBaseAsset {
  body: Readable
  byteLength: number
  contentType: 'model/gltf-binary'
}

interface InstalledLoadedPack {
  source: 'installed'
  installed: InstalledPackage
  manifest: InstalledAvatarBasePackManifest
}

interface BuiltInLoadedPack {
  source: 'builtin'
  item: CyberMarketPackage
  manifest: InstalledAvatarBasePackManifest
}

type LoadedPack = InstalledLoadedPack | BuiltInLoadedPack

/**
 * World-scoped adapter over custom world packages plus a tiny allow-list of
 * immutable, verified product assets.
 *
 * User-installed packs remain inside the existing world package authority
 * boundary. The official shared Base VRM is different: copying a 6+ MiB file
 * into every world wastes disk and backup space, so a certified Marketplace
 * copy may be exposed read-only through the same world-scoped HTTP routes.
 * No arbitrary Marketplace package can opt into this path; the host supplies
 * the exact built-in ids and LocalPackageCatalog must verify its official
 * certification and declared file hashes first.
 */
export class AvatarBasePackService {
  readonly #verification = new InstalledPackageVerificationCache()
  readonly #catalog: AvatarBasePackCatalogPort | undefined
  readonly #builtInPackageIds: readonly string[]
  /**
   * Built-in package id -> the parsed pack manifest and the exact catalog
   * content it was parsed and VRM-validated from.
   *
   * Parsing the pack manifest and asserting each Base VRM envelope costs a full
   * read of a 6+ MiB file, and both routes did it on every request. Reusing the
   * result is safe because the identity below pins the catalog entry's declared
   * inventory — every path with its SHA-256 — and the catalog only returns a
   * package whose files still hash to those exact digests. Different bytes on
   * disk therefore mean either a different identity here or no package at all;
   * the memo can never describe content the catalog did not verify.
   */
  readonly #builtIns = new Map<string, { identity: string; manifest: InstalledAvatarBasePackManifest }>()

  constructor(
    readonly worldPackages: WorldPackageInstanceService,
    options: {
      catalog?: AvatarBasePackCatalogPort
      builtInPackageIds?: readonly string[]
    } = {},
  ) {
    this.#catalog = options.catalog
    this.#builtInPackageIds = [...new Set(options.builtInPackageIds ?? [])]
  }

  async list(worldId: string): Promise<BrowserAvatarBasePackManifest[]> {
    const loaded = await this.#load(worldId)
    return loaded.map((pack) => {
      const packageId = packageIdOf(pack)
      const version = versionOf(pack)
      return {
        schemaVersion: 1,
        id: pack.manifest.id,
        version: pack.manifest.version,
        displayName: pack.manifest.displayName,
        license: pack.manifest.license,
        publisher: pack.manifest.publisher,
        quality: pack.manifest.quality,
        bases: pack.manifest.bases.map((base) => ({
          baseModel: base.baseModel,
          assetUrl: avatarPackAssetUrl(worldId, packageId, version, base.assetPath),
          cacheKey: base.cacheKey ?? (pack.source === 'builtin'
            ? `builtin-avatar-pack:${packageId}@${version}:${base.baseModel}`
            : `world-avatar-pack:${worldId}:${packageId}@${version}:${base.baseModel}`),
        })),
        parts: pack.manifest.parts,
        materialSlots: pack.manifest.materialSlots,
      }
    })
  }

  async readBaseAsset(
    worldId: string,
    packageId: string,
    version: string,
    relativePath: string,
  ): Promise<AvatarBaseAsset> {
    const loaded = (await this.#load(worldId)).find((pack) => packageIdOf(pack) === packageId && versionOf(pack) === version)
    if (loaded === undefined) throw new ServiceError('not-found', 'avatar_base_pack_not_found', '3D 角色基础包不存在或未启用')
    const base = loaded.manifest.bases.find((candidate) => candidate.assetPath === relativePath)
    if (base === undefined) throw new ServiceError('not-found', 'avatar_base_asset_not_found', '3D 角色基础模型不存在')
    const opened = loaded.source === 'builtin'
      ? await this.#catalog!.openDeclaredFile(loaded.item, base.assetPath)
      : await this.#verification.openFile(loaded.installed, base.assetPath)
    return { ...opened, contentType: 'model/gltf-binary' }
  }

  async validateInstalled(installed: InstalledPackage): Promise<InstalledAvatarBasePackManifest | undefined> {
    if (!isAvatarPackPackage(installed)) return undefined
    await this.#verification.verifyPackage(installed)
    const body = await this.#verification.readFile(installed, AVATAR_BASE_PACK_MANIFEST_PATH)
    let raw: unknown
    try {
      raw = JSON.parse(body.toString('utf8'))
    } catch {
      throw new Error(`Avatar Base Pack manifest is not valid JSON: ${installed.packageId}`)
    }
    const manifest = parseInstalledAvatarBasePackManifest(raw, installed)
    for (const base of manifest.bases) {
      const bytes = await this.#verification.readFile(installed, base.assetPath)
      assertAvatarBaseVrmEnvelope(bytes, `${installed.packageId}/${base.assetPath}`)
    }
    return manifest
  }

  async #load(worldId: string): Promise<LoadedPack[]> {
    const builtIns = await this.#loadBuiltIns()
    const reservedIds = new Set(builtIns.map((pack) => pack.item.manifest.id))
    const packages = await this.worldPackages.listRuntimePackages(worldId)
    const installed: InstalledLoadedPack[] = []
    for (const item of packages) {
      if (!isAvatarPackPackage(item) || reservedIds.has(item.packageId)) continue
      const manifest = await this.validateInstalled(item)
      if (manifest !== undefined) installed.push({ source: 'installed', installed: item, manifest })
    }
    return [...builtIns, ...installed].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)
      || right.manifest.version.localeCompare(left.manifest.version, undefined, { numeric: true, sensitivity: 'base' }))
  }

  async #loadBuiltIns(): Promise<BuiltInLoadedPack[]> {
    if (this.#catalog === undefined || this.#builtInPackageIds.length === 0) return []
    const loaded: BuiltInLoadedPack[] = []
    for (const packageId of this.#builtInPackageIds) {
      const item = await this.#catalog.find(packageId)
      if (item === undefined) continue
      // Cheap, pure and re-run on every request: the allow-list gate never
      // depends on the memo below.
      assertTrustedBuiltIn(item, packageId)
      const identity = builtInIdentity(item)
      const memo = this.#builtIns.get(packageId)
      if (memo?.identity === identity) {
        loaded.push({ source: 'builtin', item, manifest: memo.manifest })
        continue
      }
      const body = await this.#catalog.readDeclaredFile(item, AVATAR_BASE_PACK_MANIFEST_PATH)
      let raw: unknown
      try {
        raw = JSON.parse(body.toString('utf8'))
      } catch {
        throw new Error(`Built-in Avatar Base Pack manifest is not valid JSON: ${packageId}`)
      }
      const manifest = parseInstalledAvatarBasePackManifest(raw, {
        packageId: item.manifest.id,
        version: item.manifest.version,
        manifest: item.manifest,
      })
      for (const base of manifest.bases) {
        const bytes = await this.#catalog.readDeclaredFile(item, base.assetPath)
        assertAvatarBaseVrmEnvelope(bytes, `${item.manifest.id}/${base.assetPath}`)
      }
      this.#builtIns.set(packageId, { identity, manifest })
      loaded.push({ source: 'builtin', item, manifest })
    }
    return loaded
  }
}

export { isAvatarPackPackage, parseInstalledAvatarBasePackManifest } from '../avatar-base-pack-manifest.js'

function assertTrustedBuiltIn(item: CyberMarketPackage, expectedId: string): void {
  const manifest = item.manifest
  if (manifest.id !== expectedId
    || !item.verified
    || manifest.kind !== 'asset'
    || !manifest.capabilities.includes(AVATAR_BASE_PACK_CAPABILITY)
    || manifest.capabilities.some((capability) => capability !== AVATAR_BASE_PACK_CAPABILITY)
    || manifest.dataEgress.length !== 0
    || manifest.certification?.authority !== 'DSH Cyber'
    || manifest.certification?.level !== 'official') {
    throw new Error(`Built-in Avatar Base Pack failed official verification: ${expectedId}`)
  }
}

function builtInIdentity(item: CyberMarketPackage): string {
  const inventory = [...item.manifest.files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}:${file.sha256}`)
    .join('\n')
  const digest = createHash('sha256').update(inventory).digest('hex')
  return `${item.manifest.id}@${item.manifest.version}:${resolve(item.sourceDirectory)}:${item.verified}:${digest}`
}

function packageIdOf(pack: LoadedPack): string {
  return pack.source === 'builtin' ? pack.item.manifest.id : pack.installed.packageId
}

function versionOf(pack: LoadedPack): string {
  return pack.source === 'builtin' ? pack.item.manifest.version : pack.installed.version
}

function avatarPackAssetUrl(worldId: string, packageId: string, version: string, path: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/avatar-base-packs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/assets/${path.split('/').map(encodeURIComponent).join('/')}`
}
