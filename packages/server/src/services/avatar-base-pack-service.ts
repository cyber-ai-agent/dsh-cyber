import { extname } from 'node:path'

import type { InstalledPackage } from '@dsh-cyber/contracts'

import { InstalledPackageVerificationCache } from '../installed-package-runtime.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'
import { ServiceError } from './service-error.js'

export const AVATAR_BASE_PACK_CAPABILITY = 'avatar-base-pack'
export const AVATAR_BASE_PACK_MANIFEST_PATH = 'avatar-base-pack.json'

export type AvatarBaseModel = 'male-a' | 'female-a' | 'neutral-a' | 'robot-a'
export type AvatarPartKind = 'hair' | 'outfit' | 'accessory'
export type AvatarMaterialSlotId = 'skin' | 'hair' | 'outfit' | 'accent'

export interface InstalledAvatarBasePackManifest {
  schemaVersion: 1
  id: string
  version: string
  displayName: string
  license: string
  publisher: string
  quality: 'preview' | 'production'
  bases: Array<{ baseModel: AvatarBaseModel; assetPath: string; cacheKey?: string }>
  parts: Array<{ id: string; kind: AvatarPartKind; meshNames: string[]; compatibleBaseModels?: AvatarBaseModel[] }>
  materialSlots: Array<{ id: AvatarMaterialSlotId; materialNames: string[] }>
}

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
    return {
      body: await this.#verification.readFile(loaded.installed, base.assetPath),
      contentType: 'model/gltf-binary',
    }
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
    // missing/tampered 20 MB asset when the user switches to 3D later.
    for (const base of manifest.bases) {
      const bytes = await this.#verification.readFile(installed, base.assetPath)
      assertGlbEnvelope(bytes, `${installed.packageId}/${base.assetPath}`)
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

export function isAvatarPackPackage(installed: InstalledPackage): boolean {
  return installed.status === 'active'
    && installed.kind === 'asset'
    && installed.manifest.kind === 'asset'
    && installed.manifest.capabilities.includes(AVATAR_BASE_PACK_CAPABILITY)
    && installed.manifest.files.some((file) => file.path === AVATAR_BASE_PACK_MANIFEST_PATH)
}

export function parseInstalledAvatarBasePackManifest(
  value: unknown,
  installed: Pick<InstalledPackage, 'packageId' | 'version' | 'manifest'>,
): InstalledAvatarBasePackManifest {
  const source = object(value, 'Avatar Base Pack manifest')
  if (source.schemaVersion !== 1) throw new Error('Avatar Base Pack schemaVersion 必须为 1')
  const id = token(source.id, 'id')
  const version = token(source.version, 'version')
  if (id !== installed.packageId || version !== installed.version) {
    throw new Error('Avatar Base Pack id/version 必须与所属包一致')
  }
  const displayName = token(source.displayName, 'displayName')
  const license = token(source.license, 'license')
  const publisher = token(source.publisher, 'publisher')
  const quality = source.quality === 'preview' || source.quality === 'production' ? source.quality : undefined
  if (quality === undefined) throw new Error('Avatar Base Pack quality 无效')
  const basesRaw = array(source.bases, 'bases')
  if (basesRaw.length === 0) throw new Error('Avatar Base Pack 至少需要一个 Base VRM')
  const declared = new Set(installed.manifest.files.map((file) => file.path))
  const seenBases = new Set<AvatarBaseModel>()
  const bases = basesRaw.map((entry) => {
    const item = object(entry, 'base')
    const baseModel = baseModelValue(item.baseModel)
    if (seenBases.has(baseModel)) throw new Error(`Avatar Base Pack Base 重复：${baseModel}`)
    seenBases.add(baseModel)
    const assetPath = safeRelativePath(item.assetPath, 'assetPath')
    if (!declared.has(assetPath)) throw new Error(`Avatar Base Pack Base 未在包 files 中声明：${assetPath}`)
    if (extname(assetPath).toLowerCase() !== '.vrm') throw new Error(`Avatar Base Pack Base 必须是 .vrm：${assetPath}`)
    return {
      baseModel,
      assetPath,
      ...(item.cacheKey === undefined ? {} : { cacheKey: token(item.cacheKey, 'cacheKey') }),
    }
  })

  const parts = array(source.parts ?? [], 'parts').map((entry) => {
    const item = object(entry, 'part')
    const id = token(item.id, 'part.id')
    const kind = partKind(item.kind)
    const meshNames = unique(array(item.meshNames, 'meshNames').map((name) => token(name, 'meshName')))
    if (meshNames.length === 0) throw new Error(`Avatar Base Pack Part 没有 mesh：${kind}:${id}`)
    const compatibleBaseModels = item.compatibleBaseModels === undefined
      ? undefined
      : unique(array(item.compatibleBaseModels, 'compatibleBaseModels').map(baseModelValue))
    return { id, kind, meshNames, ...(compatibleBaseModels === undefined ? {} : { compatibleBaseModels }) }
  })
  const identities = new Set<string>()
  for (const part of parts) {
    const identity = `${part.kind}:${part.id}`
    if (identities.has(identity)) throw new Error(`Avatar Base Pack Part 重复：${identity}`)
    identities.add(identity)
  }

  const materialSlots = array(source.materialSlots ?? [], 'materialSlots').map((entry) => {
    const item = object(entry, 'materialSlot')
    const id = materialSlot(item.id)
    const materialNames = unique(array(item.materialNames, 'materialNames').map((name) => token(name, 'materialName')))
    if (materialNames.length === 0) throw new Error(`Avatar Base Pack 材质槽为空：${id}`)
    return { id, materialNames }
  })
  if (new Set(materialSlots.map((slot) => slot.id)).size !== materialSlots.length) throw new Error('Avatar Base Pack 材质槽重复')

  return { schemaVersion: 1, id, version, displayName, license, publisher, quality, bases, parts, materialSlots }
}

function avatarPackAssetUrl(worldId: string, packageId: string, version: string, path: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/avatar-base-packs/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/assets/${path.split('/').map(encodeURIComponent).join('/')}`
}

function assertGlbEnvelope(body: Buffer, label: string): void {
  if (body.byteLength < 20 || body.readUInt32LE(0) !== 0x46546c67 || body.readUInt32LE(4) !== 2 || body.readUInt32LE(8) !== body.byteLength) {
    throw new Error(`Avatar Base Pack VRM 不是有效的 GLB 2.0：${label}`)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 必须为对象`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须为数组`)
  return value
}

function token(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须为字符串`)
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 160) throw new Error(`${label} 无效`)
  return trimmed
}

function safeRelativePath(value: unknown, label: string): string {
  const path = token(value, label)
  if (path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/u.test(path)
    || path.split('/').some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`${label} 必须是安全的包内相对路径`)
  }
  return path
}

function baseModelValue(value: unknown): AvatarBaseModel {
  if (value === 'male-a' || value === 'female-a' || value === 'neutral-a' || value === 'robot-a') return value
  throw new Error('Avatar Base Pack baseModel 无效')
}

function partKind(value: unknown): AvatarPartKind {
  if (value === 'hair' || value === 'outfit' || value === 'accessory') return value
  throw new Error('Avatar Base Pack part.kind 无效')
}

function materialSlot(value: unknown): AvatarMaterialSlotId {
  if (value === 'skin' || value === 'hair' || value === 'outfit' || value === 'accent') return value
  throw new Error('Avatar Base Pack material slot 无效')
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
