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

export interface AvatarRecipe {
  schemaVersion: typeof AVATAR_RECIPE_SCHEMA_VERSION
  baseModel: AvatarBaseModel
  hair?: string
  hairColor?: string
  skinTone?: string
  outfit?: string
  outfitColor?: string
  accessoryIds?: string[]
}

export const DEFAULT_AVATAR_RECIPE: AvatarRecipe = {
  schemaVersion: AVATAR_RECIPE_SCHEMA_VERSION,
  baseModel: 'neutral-a',
}

const BASE_MODELS = new Set<AvatarBaseModel>(['male-a', 'female-a', 'neutral-a', 'robot-a'])
const MAX_ACCESSORIES = 8
const MAX_TOKEN_LENGTH = 64

/**
 * Reads a recipe from stored or transported data.
 *
 * Recipes arrive from a character's revision, from an installed package, and
 * eventually from a generator's own output, so this is untrusted input. An
 * unreadable recipe becomes the default rather than an error: a character with
 * a corrupt appearance should still be in the world.
 */
export function parseAvatarRecipe(value: unknown): AvatarRecipe {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_AVATAR_RECIPE
  const source = value as Record<string, unknown>
  const baseModel = typeof source.baseModel === 'string' && BASE_MODELS.has(source.baseModel as AvatarBaseModel)
    ? source.baseModel as AvatarBaseModel
    : DEFAULT_AVATAR_RECIPE.baseModel
  const accessories = Array.isArray(source.accessoryIds)
    ? source.accessoryIds.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim().slice(0, MAX_TOKEN_LENGTH))
      .slice(0, MAX_ACCESSORIES)
    : []
  return {
    schemaVersion: AVATAR_RECIPE_SCHEMA_VERSION,
    baseModel,
    ...token(source.hair, 'hair'),
    ...colour(source.hairColor, 'hairColor'),
    ...colour(source.skinTone, 'skinTone'),
    ...token(source.outfit, 'outfit'),
    ...colour(source.outfitColor, 'outfitColor'),
    ...(accessories.length === 0 ? {} : { accessoryIds: accessories }),
  }
}

/**
 * What two characters can share.
 *
 * Only the base model is heavy: hair, colours and accessories are applied on
 * top of an already-loaded body. Keying a download cache on this means every
 * character built from `neutral-a` fetches it once, whatever else differs.
 */
export function avatarBaseKey(recipe: AvatarRecipe): string {
  return `avatar-base:${recipe.baseModel}`
}

/** Whether two recipes would produce the same character. */
export function sameAvatarRecipe(left: AvatarRecipe, right: AvatarRecipe): boolean {
  return left.baseModel === right.baseModel
    && left.hair === right.hair
    && left.hairColor === right.hairColor
    && left.skinTone === right.skinTone
    && left.outfit === right.outfit
    && left.outfitColor === right.outfitColor
    && (left.accessoryIds ?? []).join(',') === (right.accessoryIds ?? []).join(',')
}

function token(value: unknown, key: string): Record<string, string> {
  if (typeof value !== 'string') return {}
  const trimmed = value.trim().slice(0, MAX_TOKEN_LENGTH)
  return trimmed === '' ? {} : { [key]: trimmed }
}

/**
 * A colour, only if it is one.
 *
 * Anything reaching a material has to be a colour and nothing else: a recipe
 * travels in a package, and a string that is not a colour is either a mistake
 * or an attempt to put something else where a colour is expected.
 */
function colour(value: unknown, key: string): Record<string, string> {
  if (typeof value !== 'string') return {}
  const trimmed = value.trim()
  return /^#[0-9a-f]{6}$/iu.test(trimmed) ? { [key]: trimmed.toLowerCase() } : {}
}
