import { parseAvatarRecipe, type AvatarBaseModel, type AvatarRecipe } from './avatar-recipe.js'

/**
 * A reusable, authored VRM body with named variant meshes.
 *
 * The pack is deliberately data-only. Importing this module must never pull
 * Three.js into the first screen: the actual scene mutation lives beside the
 * lazy VRM runtime.
 */
export interface AvatarBasePackManifest {
  schemaVersion: 1
  id: string
  version: string
  displayName: string
  license: string
  publisher: string
  quality: 'preview' | 'production'
  bases: AvatarBasePackBase[]
  parts: AvatarBasePackPart[]
  materialSlots: AvatarBasePackMaterialSlot[]
}

export interface AvatarBasePackBase {
  baseModel: AvatarBaseModel
  assetUrl: string
  /** Stable shared byte-cache key. Defaults to pack/version/baseModel. */
  cacheKey?: string
}

export type AvatarPartKind = 'hair' | 'outfit' | 'accessory'

export interface AvatarBasePackPart {
  id: string
  kind: AvatarPartKind
  /** Exact Object3D names authored into the shared VRM. */
  meshNames: string[]
  compatibleBaseModels?: AvatarBaseModel[]
}

export type AvatarMaterialSlotId = 'skin' | 'hair' | 'outfit' | 'accent'

export interface AvatarBasePackMaterialSlot {
  id: AvatarMaterialSlotId
  /** Exact material names authored into the shared VRM. */
  materialNames: string[]
}

/** Everything the lazy VRM runtime needs to instantiate one employee. */
export interface AvatarAssemblyPlan {
  source: 'base-pack'
  packId: string
  packVersion: string
  baseModel: AvatarBaseModel
  assetUrl: string
  cacheKey: string
  /** Names enabled after all authored variant meshes have first been hidden. */
  visibleMeshNames: string[]
  /** Every optional mesh controlled by this pack. */
  managedMeshNames: string[]
  materialColours: Partial<Record<AvatarMaterialSlotId, string>>
}

export interface AvatarRepresentation {
  assetUrl: string
  cacheKey?: string
  assembly?: AvatarAssemblyPlan
}

/**
 * Keeps high-quality packs pluggable without letting an arbitrary employee
 * profile become an asset URL. Pack manifests are trusted/install-time data;
 * recipes may only select named variants inside them.
 */
export class AvatarBasePackRegistry {
  readonly #packs = new Map<string, AvatarBasePackManifest>()

  register(value: AvatarBasePackManifest): void {
    const pack = parseAvatarBasePackManifest(value)
    const key = packKey(pack.id, pack.version)
    if (this.#packs.has(key)) throw new Error(`Avatar Base Pack 重复注册：${key}`)
    this.#packs.set(key, pack)
  }

  list(): AvatarBasePackManifest[] {
    return [...this.#packs.values()]
  }

  resolve(recipeValue: AvatarRecipe, preferredPackId?: string): AvatarAssemblyPlan | undefined {
    const recipe = parseAvatarRecipe(recipeValue)
    const candidates = [...this.#packs.values()]
      .filter((pack) => pack.quality === 'production' && (preferredPackId === undefined || pack.id === preferredPackId))
      .filter((pack) => pack.bases.some((base) => base.baseModel === recipe.baseModel))
      .sort(comparePackVersionDescending)
    const pack = candidates[0]
    return pack === undefined ? undefined : assemblyPlanFor(pack, recipe)
  }
}

/** No fake default model: product packs opt in by registering real assets. */
export const avatarBasePacks = new AvatarBasePackRegistry()

export function assemblyPlanFor(packValue: AvatarBasePackManifest, recipeValue: AvatarRecipe): AvatarAssemblyPlan {
  const pack = parseAvatarBasePackManifest(packValue)
  const recipe = parseAvatarRecipe(recipeValue)
  const base = pack.bases.find((candidate) => candidate.baseModel === recipe.baseModel)
  if (base === undefined) throw new Error(`Avatar Base Pack ${pack.id} 不支持 ${recipe.baseModel}`)

  const compatibleParts = pack.parts.filter((part) => part.compatibleBaseModels === undefined || part.compatibleBaseModels.includes(recipe.baseModel))
  const requested = new Set<string>([
    ...(recipe.hair === undefined ? [] : [recipe.hair]),
    ...(recipe.outfit === undefined ? [] : [recipe.outfit]),
    ...(recipe.accessoryIds ?? []),
  ])
  const visible = compatibleParts.filter((part) => requested.has(part.id)).flatMap((part) => part.meshNames)
  const managed = compatibleParts.flatMap((part) => part.meshNames)
  return {
    source: 'base-pack',
    packId: pack.id,
    packVersion: pack.version,
    baseModel: recipe.baseModel,
    assetUrl: base.assetUrl,
    cacheKey: base.cacheKey ?? `avatar-pack:${pack.id}@${pack.version}:${recipe.baseModel}`,
    visibleMeshNames: unique(visible),
    managedMeshNames: unique(managed),
    materialColours: {
      ...(recipe.skinTone === undefined ? {} : { skin: recipe.skinTone }),
      ...(recipe.hairColor === undefined ? {} : { hair: recipe.hairColor }),
      ...(recipe.outfitColor === undefined ? {} : { outfit: recipe.outfitColor }),
      ...(recipe.accentColor === undefined ? {} : { accent: recipe.accentColor }),
    },
  }
}

export function parseAvatarBasePackManifest(value: AvatarBasePackManifest): AvatarBasePackManifest {
  if (value.schemaVersion !== 1) throw new Error('Avatar Base Pack schemaVersion 必须为 1')
  const id = requiredToken(value.id, 'id')
  const version = requiredToken(value.version, 'version')
  const displayName = requiredToken(value.displayName, 'displayName')
  const license = requiredToken(value.license, 'license')
  const publisher = requiredToken(value.publisher, 'publisher')
  if (value.quality !== 'preview' && value.quality !== 'production') throw new Error('Avatar Base Pack quality 无效')
  if (!Array.isArray(value.bases) || value.bases.length === 0) throw new Error('Avatar Base Pack 至少需要一个 Base VRM')
  const seenBases = new Set<AvatarBaseModel>()
  const bases = value.bases.map((base) => {
    if (seenBases.has(base.baseModel)) throw new Error(`Avatar Base Pack Base 重复：${base.baseModel}`)
    seenBases.add(base.baseModel)
    return {
      baseModel: base.baseModel,
      assetUrl: safeAssetUrl(base.assetUrl),
      ...(base.cacheKey === undefined ? {} : { cacheKey: requiredToken(base.cacheKey, 'cacheKey') }),
    }
  })
  const seenParts = new Set<string>()
  const parts = (value.parts ?? []).map((part) => {
    const partId = requiredToken(part.id, 'part.id')
    const identity = `${part.kind}:${partId}`
    if (seenParts.has(identity)) throw new Error(`Avatar Base Pack Part 重复：${identity}`)
    seenParts.add(identity)
    if (part.kind !== 'hair' && part.kind !== 'outfit' && part.kind !== 'accessory') throw new Error(`Avatar Base Pack Part 类型无效：${part.kind}`)
    const meshNames = unique(part.meshNames.map((name) => requiredToken(name, 'meshName')))
    if (meshNames.length === 0) throw new Error(`Avatar Base Pack Part 没有 mesh：${identity}`)
    return {
      id: partId,
      kind: part.kind,
      meshNames,
      ...(part.compatibleBaseModels === undefined ? {} : { compatibleBaseModels: unique(part.compatibleBaseModels) }),
    }
  })
  const seenSlots = new Set<AvatarMaterialSlotId>()
  const materialSlots = (value.materialSlots ?? []).map((slot) => {
    if (!isMaterialSlot(slot.id)) throw new Error(`Avatar Base Pack 材质槽无效：${slot.id}`)
    if (seenSlots.has(slot.id)) throw new Error(`Avatar Base Pack 材质槽重复：${slot.id}`)
    seenSlots.add(slot.id)
    const materialNames = unique(slot.materialNames.map((name) => requiredToken(name, 'materialName')))
    if (materialNames.length === 0) throw new Error(`Avatar Base Pack 材质槽为空：${slot.id}`)
    return { id: slot.id, materialNames }
  })
  return { schemaVersion: 1, id, version, displayName, license, publisher, quality: value.quality, bases, parts, materialSlots }
}

export function materialNamesFor(pack: AvatarBasePackManifest, slot: AvatarMaterialSlotId): string[] {
  return pack.materialSlots.find((entry) => entry.id === slot)?.materialNames ?? []
}

function safeAssetUrl(value: string): string {
  const url = requiredToken(value, 'assetUrl')
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return url
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error('Avatar Base Pack 只允许站内绝对路径或 HTTPS 资源')
}

function requiredToken(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`Avatar Base Pack ${label} 必须为字符串`)
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 160) throw new Error(`Avatar Base Pack ${label} 无效`)
  return trimmed
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function isMaterialSlot(value: string): value is AvatarMaterialSlotId {
  return value === 'skin' || value === 'hair' || value === 'outfit' || value === 'accent'
}

function packKey(id: string, version: string): string {
  return `${id}@${version}`
}

function comparePackVersionDescending(left: AvatarBasePackManifest, right: AvatarBasePackManifest): number {
  if (left.id !== right.id) return left.id.localeCompare(right.id)
  return right.version.localeCompare(left.version, undefined, { numeric: true, sensitivity: 'base' })
}
