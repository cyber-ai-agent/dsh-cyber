import { extname } from 'node:path'

import type { InstalledPackage } from '@dsh-cyber/contracts'

export const AVATAR_BASE_PACK_CAPABILITY = 'avatar:base-pack'
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

export function isAvatarPackPackage(installed: Pick<InstalledPackage, 'status' | 'kind' | 'manifest'>): boolean {
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
  if (id !== installed.packageId || version !== installed.version) throw new Error('Avatar Base Pack id/version 必须与所属包一致')
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
    return { baseModel, assetPath, ...(item.cacheKey === undefined ? {} : { cacheKey: token(item.cacheKey, 'cacheKey') }) }
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

/**
 * Production Base Packs are stricter than generic GLB previews: the file must
 * be a self-contained VRM 1.0 Humanoid. This keeps a package from passing the
 * catalog check and only failing much later inside Three/VRMLoaderPlugin.
 */
export function assertAvatarBaseVrmEnvelope(body: Buffer, label: string): void {
  if (body.byteLength < 20 || body.readUInt32LE(0) !== 0x46546c67 || body.readUInt32LE(4) !== 2 || body.readUInt32LE(8) !== body.byteLength) {
    throw new Error(`Avatar Base Pack VRM 不是有效的 GLB 2.0：${label}`)
  }
  const jsonLength = body.readUInt32LE(12)
  const jsonType = body.readUInt32LE(16)
  if (jsonType !== 0x4e4f534a || jsonLength <= 0 || 20 + jsonLength > body.byteLength) {
    throw new Error(`Avatar Base Pack VRM 缺少有效 JSON chunk：${label}`)
  }
  let document: Record<string, unknown>
  try {
    document = JSON.parse(body.subarray(20, 20 + jsonLength).toString('utf8').trim()) as Record<string, unknown>
  } catch {
    throw new Error(`Avatar Base Pack VRM JSON 无法解析：${label}`)
  }
  const extensions = record(document.extensions)
  const vrm = record(extensions?.VRMC_vrm)
  if (vrm?.specVersion !== '1.0') throw new Error(`Avatar Base Pack 必须是 VRM 1.0：${label}`)
  const humanoid = record(vrm.humanoid)
  const humanBones = record(humanoid?.humanBones)
  for (const bone of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg']) {
    if (record(humanBones?.[bone]) === undefined) throw new Error(`Avatar Base Pack VRM 缺少 Humanoid 骨骼 ${bone}：${label}`)
  }
  for (const buffer of arrayOrEmpty(document.buffers)) {
    const uri = record(buffer)?.uri
    if (typeof uri === 'string' && !uri.startsWith('data:')) throw new Error(`Avatar Base Pack VRM 不允许外链 buffer：${label}`)
  }
  for (const image of arrayOrEmpty(document.images)) {
    const uri = record(image)?.uri
    if (typeof uri === 'string' && !uri.startsWith('data:')) throw new Error(`Avatar Base Pack VRM 不允许外链纹理：${label}`)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 必须为对象`)
  return value as Record<string, unknown>
}
function record(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须为数组`)
  return value
}
function arrayOrEmpty(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
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
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)] }
