import type { CharacterGender, JsonObject } from '@dsh-cyber/contracts'

/**
 * What a character looks like, as a description rather than a file.
 *
 * A world of fifty characters cannot be fifty hand-made models: each one is a
 * multi-megabyte download, and nobody is going to author fifty. A recipe says
 * which base model to start from and what to change about it, so characters
 * share the expensive part and differ in the cheap part.
 *
 * Deliberately data, not geometry. Nothing here knows about three, meshes or
 * materials — a recipe is stored with the character, travels in a package, and
 * is applied by whichever generator is installed. That is what keeps it usable
 * by the procedural generator today and by a better one later without changing
 * what a character *is*.
 */

export const AVATAR_RECIPE_SCHEMA_VERSION = 1

export type AvatarBaseModel = 'male-a' | 'female-a' | 'neutral-a' | 'robot-a'
export type AvatarBuild = 'slender' | 'balanced' | 'sturdy'

export interface AvatarRecipe {
  schemaVersion: typeof AVATAR_RECIPE_SCHEMA_VERSION
  baseModel: AvatarBaseModel
  build?: AvatarBuild
  hair?: string
  hairColor?: string
  skinTone?: string
  outfit?: string
  outfitColor?: string
  accentColor?: string
  accessoryIds?: string[]
}

export interface CharacterAvatarIdentity {
  employeeId: string
  role?: string | undefined
  gender?: CharacterGender | undefined
  fallbackAvatarIndex?: number | undefined
  appearance?: JsonObject | undefined
}

export const DEFAULT_AVATAR_RECIPE: AvatarRecipe = {
  schemaVersion: AVATAR_RECIPE_SCHEMA_VERSION,
  baseModel: 'neutral-a',
  build: 'balanced',
}

const BASE_MODELS = new Set<AvatarBaseModel>(['male-a', 'female-a', 'neutral-a', 'robot-a'])
const BUILDS = new Set<AvatarBuild>(['slender', 'balanced', 'sturdy'])
const MAX_ACCESSORIES = 8
const MAX_TOKEN_LENGTH = 64

/**
 * The eight built-in 2D portraits already act as identity seeds throughout the
 * product. Their palette and silhouette now seed 3D too, so moving into the
 * Three world does not throw away the visual identity the user already knows.
 *
 * These are intentionally recipes rather than generator knobs: a future high
 * quality Base-VRM provider can consume the same data without changing the
 * character profile contract.
 */
const BUILTIN_IDENTITY_RECIPES: readonly AvatarRecipe[] = [
  recipe('neutral-a', 'balanced', 'long-layered', '#7c3aed', 'professional', '#4338ca', '#c4b5fd'),
  recipe('neutral-a', 'sturdy', 'side-part', '#1e293b', 'professional', '#1e3a8a', '#60a5fa', ['glasses']),
  recipe('neutral-a', 'balanced', 'tech-crop', '#31553a', 'casual', '#166534', '#4ade80'),
  recipe('neutral-a', 'slender', 'bob', '#6b4423', 'casual', '#92400e', '#fbbf24'),
  recipe('neutral-a', 'balanced', 'ponytail', '#6d293d', 'future', '#991b1b', '#fb7185'),
  recipe('neutral-a', 'sturdy', 'tech-crop', '#164e63', 'future', '#0e7490', '#67e8f9'),
  recipe('neutral-a', 'balanced', 'soft-volume', '#9a3412', 'professional', '#c2410c', '#fb923c', ['glasses']),
  recipe('neutral-a', 'slender', 'side-part', '#64748b', 'professional', '#475569', '#cbd5e1'),
]

/**
 * Produces the character's stable appearance recipe from identity data.
 *
 * Priority is deliberately explicit: built-in portrait → gender/role hints →
 * stored recipe overrides. The employee id is only a deterministic tiebreaker;
 * names never influence appearance, so renaming a character cannot change its
 * face or clothes.
 */
export function avatarRecipeForCharacter(identity: CharacterAvatarIdentity): AvatarRecipe {
  const requestedIndex = identity.fallbackAvatarIndex ?? numericAppearance(identity.appearance, 'avatarIndex') ?? stableIndex(identity.employeeId)
  const index = modulo(Math.floor(requestedIndex), BUILTIN_IDENTITY_RECIPES.length)
  const seed = BUILTIN_IDENTITY_RECIPES[index] ?? DEFAULT_AVATAR_RECIPE
  const roleOutfit = outfitForRole(identity.role)
  const baseline: AvatarRecipe = {
    ...seed,
    baseModel: baseForGender(identity.gender),
    ...(roleOutfit === undefined ? {} : { outfit: roleOutfit }),
  }
  const stored = recipeOverrides(identity.appearance?.['avatarRecipe'])
  return parseAvatarRecipe({ ...baseline, ...stored })
}

/**
 * Reads a recipe from stored or transported data.
 *
 * Recipes arrive from a character's revision, from an installed package, and
 * eventually from a generator's own output, so this is untrusted input. An
 * unreadable recipe becomes the default rather than an error: a character with
 * a corrupt appearance should still be in the world.
 */
export function parseAvatarRecipe(value: unknown): AvatarRecipe {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...DEFAULT_AVATAR_RECIPE }
  const source = value as Record<string, unknown>
  const baseModel = typeof source.baseModel === 'string' && BASE_MODELS.has(source.baseModel as AvatarBaseModel)
    ? source.baseModel as AvatarBaseModel
    : DEFAULT_AVATAR_RECIPE.baseModel
  const build = typeof source.build === 'string' && BUILDS.has(source.build as AvatarBuild)
    ? source.build as AvatarBuild
    : DEFAULT_AVATAR_RECIPE.build
  const accessories = Array.isArray(source.accessoryIds)
    ? source.accessoryIds.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim().slice(0, MAX_TOKEN_LENGTH))
      .slice(0, MAX_ACCESSORIES)
    : []
  return {
    schemaVersion: AVATAR_RECIPE_SCHEMA_VERSION,
    baseModel,
    ...(build === undefined ? {} : { build }),
    ...token(source.hair, 'hair'),
    ...colour(source.hairColor, 'hairColor'),
    ...colour(source.skinTone, 'skinTone'),
    ...token(source.outfit, 'outfit'),
    ...colour(source.outfitColor, 'outfitColor'),
    ...colour(source.accentColor, 'accentColor'),
    ...(accessories.length === 0 ? {} : { accessoryIds: accessories }),
  }
}

/** The heavy body can be shared while cheap identity layers vary per employee. */
export function avatarBaseKey(recipe: AvatarRecipe): string {
  return `avatar-base:${recipe.baseModel}`
}

/** Whether two recipes would produce the same character. */
export function sameAvatarRecipe(left: AvatarRecipe, right: AvatarRecipe): boolean {
  return left.baseModel === right.baseModel
    && left.build === right.build
    && left.hair === right.hair
    && left.hairColor === right.hairColor
    && left.skinTone === right.skinTone
    && left.outfit === right.outfit
    && left.outfitColor === right.outfitColor
    && left.accentColor === right.accentColor
    && (left.accessoryIds ?? []).join(',') === (right.accessoryIds ?? []).join(',')
}

function recipe(
  baseModel: AvatarBaseModel,
  build: AvatarBuild,
  hair: string,
  hairColor: string,
  outfit: string,
  outfitColor: string,
  accentColor: string,
  accessoryIds?: string[],
): AvatarRecipe {
  return {
    schemaVersion: AVATAR_RECIPE_SCHEMA_VERSION,
    baseModel,
    build,
    hair,
    hairColor,
    skinTone: '#d9a67f',
    outfit,
    outfitColor,
    accentColor,
    ...(accessoryIds === undefined ? {} : { accessoryIds }),
  }
}

function baseForGender(gender: CharacterGender | undefined): AvatarBaseModel {
  if (gender === 'female') return 'female-a'
  if (gender === 'male') return 'male-a'
  return 'neutral-a'
}

function outfitForRole(role: string | undefined): string | undefined {
  const value = role?.trim().toLowerCase() ?? ''
  if (value === '') return undefined
  if (/数据|分析|研究|research|analyst/u.test(value)) return 'analyst'
  if (/工程|开发|架构|运维|测试|安全|engineer|developer|architect|security|qa/u.test(value)) return 'engineer'
  if (/产品|经理|管理|秘书|总裁|主管|product|manager|executive|secretary/u.test(value)) return 'professional'
  return undefined
}

function recipeOverrides(value: unknown): Partial<AvatarRecipe> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const parsed = parseAvatarRecipe(source)
  return {
    ...(typeof source.baseModel === 'string' && BASE_MODELS.has(source.baseModel as AvatarBaseModel) ? { baseModel: parsed.baseModel } : {}),
    ...(typeof source.build === 'string' && BUILDS.has(source.build as AvatarBuild) && parsed.build !== undefined ? { build: parsed.build } : {}),
    ...(typeof source.hair === 'string' && parsed.hair !== undefined ? { hair: parsed.hair } : {}),
    ...(typeof source.hairColor === 'string' && parsed.hairColor !== undefined ? { hairColor: parsed.hairColor } : {}),
    ...(typeof source.skinTone === 'string' && parsed.skinTone !== undefined ? { skinTone: parsed.skinTone } : {}),
    ...(typeof source.outfit === 'string' && parsed.outfit !== undefined ? { outfit: parsed.outfit } : {}),
    ...(typeof source.outfitColor === 'string' && parsed.outfitColor !== undefined ? { outfitColor: parsed.outfitColor } : {}),
    ...(typeof source.accentColor === 'string' && parsed.accentColor !== undefined ? { accentColor: parsed.accentColor } : {}),
    ...(Array.isArray(source.accessoryIds) && parsed.accessoryIds !== undefined ? { accessoryIds: parsed.accessoryIds } : {}),
  }
}

function numericAppearance(appearance: JsonObject | undefined, key: string): number | undefined {
  const value = appearance?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stableIndex(employeeId: string): number {
  let hash = 2166136261
  for (const character of employeeId) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function modulo(value: number, length: number): number {
  return ((value % length) + length) % length
}

function token(value: unknown, key: string): Record<string, string> {
  if (typeof value !== 'string') return {}
  const trimmed = value.trim().slice(0, MAX_TOKEN_LENGTH)
  return trimmed === '' ? {} : { [key]: trimmed }
}

/** Only canonical hex colours are allowed to reach materials. */
function colour(value: unknown, key: string): Record<string, string> {
  if (typeof value !== 'string') return {}
  const trimmed = value.trim()
  return /^#[0-9a-f]{6}$/iu.test(trimmed) ? { [key]: trimmed.toLowerCase() } : {}
}
