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
  ): Promise<{ body: Buffer; contentType: 'model/gltf-binary' }> {
    const loaded = (await this.#load(worldId)).find((pack) => packageIdOf(pack) === packageId && versionOf(pack) === version)
    if (loaded === undefined) throw new ServiceError('not-found', 'avatar_base_pack_not_found', '3D 角色基础包不存在或未启用')
    const base = loaded.manifest.bases.find((candidate) => candidate.assetPath === relativePath)
    if (base === undefined) throw new ServiceError('not-found', 'avatar_base_asset_not_found', '3D 角色基础模型不存在')
    const body = loaded.source === 'builtin'
      ? await this.#catalog!.readDeclaredFile(loaded.item, base.assetPath)
      : await this.#verification.readFile(loaded.installed, base.assetPath)
    return { body, contentType: 'model/gltf-binary' }
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
      assertTrustedBuiltIn(item, packageId)
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

function packageIdOf(pack: LoadedPack): string {
  return pack.source === 'builtin' ? pack.item.manifest.id : pack.installed.packageId
}

function versionOf(pack: LoadedPack): string {
  return pack.source === 'builtin' ? pack.item.manifest.version : pack.installed.version
}

function avatarPackAssetUrl(worldId: string, packageId: string, version: string, path: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/avatar-base-packs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/assets/${path.split('/').map(encodeURIComponent).join('/')}`
}
