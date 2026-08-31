import type { InstalledPackage } from '@dsh-cyber/contracts'

import {
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

interface LoadedPack {
  installed: InstalledPackage
  manifest: InstalledAvatarBasePackManifest
}

/**
 * World-scoped adapter over the existing package runtime.
 *
 * Avatar bytes never come from profile URLs or arbitrary filesystem paths.
 * Only an active world package with the explicit capability, a declared
 * manifest and hash-verified declared VRM files can become a production pack.
 */
export class AvatarBasePackService {
  readonly #verification = new InstalledPackageVerificationCache()

  constructor(readonly worldPackages: WorldPackageInstanceService) {}

  async list(worldId: string): Promise<BrowserAvatarBasePackManifest[]> {
    const loaded = await this.#load(worldId)
    return loaded.map(({ installed, manifest }) => ({
      schemaVersion: 1,
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      license: manifest.license,
      publisher: manifest.publisher,
      quality: manifest.quality,
      bases: manifest.bases.map((base) => ({
        baseModel: base.baseModel,
        assetUrl: avatarPackAssetUrl(worldId, installed.packageId, installed.version, base.assetPath),
        cacheKey: base.cacheKey ?? `world-avatar-pack:${worldId}:${installed.packageId}@${installed.version}:${base.baseModel}`,
      })),
      parts: manifest.parts,
      materialSlots: manifest.materialSlots,
    }))
  }

  async readBaseAsset(
    worldId: string,
    packageId: string,
    version: string,
    relativePath: string,
  ): Promise<{ body: Buffer; contentType: 'model/gltf-binary' }> {
    const loaded = (await this.#load(worldId)).find(({ installed }) => installed.packageId === packageId && installed.version === version)
    if (loaded === undefined) throw new ServiceError('not-found', 'avatar_base_pack_not_found', '3D 角色基础包不存在或未启用')
    const base = loaded.manifest.bases.find((candidate) => candidate.assetPath === relativePath)
    if (base === undefined) throw new ServiceError('not-found', 'avatar_base_asset_not_found', '3D 角色基础模型不存在')
    return { body: await this.#verification.readFile(loaded.installed, base.assetPath), contentType: 'model/gltf-binary' }
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
    // Force every Base VRM through verification now rather than discovering a
    // missing/tampered asset only when the user switches to 3D later.
    for (const base of manifest.bases) {
      const bytes = await this.#verification.readFile(installed, base.assetPath)
      assertAvatarBaseVrmEnvelope(bytes, `${installed.packageId}/${base.assetPath}`)
    }
    return manifest
  }

  async #load(worldId: string): Promise<LoadedPack[]> {
    const packages = await this.worldPackages.listRuntimePackages(worldId)
    const loaded: LoadedPack[] = []
    for (const installed of packages) {
      if (!isAvatarPackPackage(installed)) continue
      const manifest = await this.validateInstalled(installed)
      if (manifest !== undefined) loaded.push({ installed, manifest })
    }
    return loaded.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)
      || right.manifest.version.localeCompare(left.manifest.version, undefined, { numeric: true, sensitivity: 'base' }))
  }
}

export { isAvatarPackPackage, parseInstalledAvatarBasePackManifest } from '../avatar-base-pack-manifest.js'

function avatarPackAssetUrl(worldId: string, packageId: string, version: string, path: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/avatar-base-packs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/assets/${path.split('/').map(encodeURIComponent).join('/')}`
}
