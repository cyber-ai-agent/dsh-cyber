import type { CharacterGender, JsonObject } from '@dsh-cyber/contracts'

import {
  avatarBasePacks,
  assemblyPlanFor,
  materialNamesFor,
  type AvatarAssemblyPlan,
  type AvatarBasePackManifest,
  type AvatarMaterialSlotId,
  type AvatarPartKind,
} from './avatar-base-pack.js'
import {
  avatarRecipeForCharacter,
  parseAvatarRecipe,
  type AvatarBaseModel,
  type AvatarRecipe,
} from './avatar-recipe.js'

/**
 * A detailed 3D model is only an upgrade if the user can still recognise the
 * same character. Hair and outfit are therefore hard identity gates rather
 * than cosmetic bonus points.
 */
export const MIN_PRODUCTION_AVATAR_IDENTITY_SCORE = 0.78

export interface AvatarPackIdentityMatch {
  pack: AvatarBasePackManifest
  plan: AvatarAssemblyPlan
  score: number
  criticalMissing: string[]
  optionalMissing: string[]
  eligible: boolean
}

export interface ResolvedAvatarRepresentation {
  source: 'published' | 'base-pack'
  /** Changes whenever the visual representation should be reloaded. */
  key: string
  assetUrl: string
  cacheKey?: string
  assembly?: { pack: AvatarBasePackManifest; plan: AvatarAssemblyPlan }
  identityScore?: number
}

export interface CharacterRepresentationInput {
  employeeId: string
  role?: string | undefined
  gender?: CharacterGender | undefined
  fallbackAvatarIndex?: number | undefined
  appearance?: JsonObject | undefined
  /** A published employee-specific VRM always wins over a shared pack. */
  publishedAvatarUrl?: string | undefined
  /** Optional explicit installed pack preference stored by a future pack picker. */
  preferredPackId?: string | undefined
}

export function resolveCharacterAvatarRepresentation(
  input: CharacterRepresentationInput,
  packs: readonly AvatarBasePackManifest[] = avatarBasePacks.list(),
): ResolvedAvatarRepresentation | undefined {
  if (input.publishedAvatarUrl !== undefined) {
    return {
      source: 'published',
      key: `published:${input.publishedAvatarUrl}`,
      assetUrl: input.publishedAvatarUrl,
      cacheKey: `employee-avatar:${input.employeeId}:${input.publishedAvatarUrl}`,
    }
  }

  const recipe = avatarRecipeForCharacter({
    employeeId: input.employeeId,
    role: input.role,
    gender: input.gender,
    fallbackAvatarIndex: input.fallbackAvatarIndex,
    appearance: input.appearance,
  })
  const match = bestAvatarPackMatch(recipe, packs, input.preferredPackId)
  if (match === undefined || !match.eligible) return undefined
  return {
    source: 'base-pack',
    key: `base-pack:${match.pack.id}@${match.pack.version}:${recipeFingerprint(recipe)}`,
    assetUrl: match.plan.assetUrl,
    cacheKey: match.plan.cacheKey,
    assembly: { pack: match.pack, plan: match.plan },
    identityScore: match.score,
  }
}

export function bestAvatarPackMatch(
  recipeValue: AvatarRecipe,
  packs: readonly AvatarBasePackManifest[],
  preferredPackId?: string,
): AvatarPackIdentityMatch | undefined {
  const recipe = parseAvatarRecipe(recipeValue)
  return packs
    .filter((pack) => pack.quality === 'production')
    .filter((pack) => preferredPackId === undefined || pack.id === preferredPackId)
    .filter((pack) => pack.bases.some((base) => base.baseModel === recipe.baseModel))
    .map((pack) => avatarPackIdentityMatch(pack, recipe))
    .sort(compareMatches)[0]
}

export function avatarPackIdentityMatch(
  pack: AvatarBasePackManifest,
  recipeValue: AvatarRecipe,
): AvatarPackIdentityMatch {
  const recipe = parseAvatarRecipe(recipeValue)
  const basePlan = assemblyPlanFor(pack, recipe)
  // Rebuild visible names by kind. The v1 assembly helper accepts a flat id
  // set, so a hair and outfit that happen to share an id could otherwise both
  // turn on. Installed content is not allowed to exploit that ambiguity.
  const plan: AvatarAssemblyPlan = {
    ...basePlan,
    visibleMeshNames: identityVisibleMeshes(pack, recipe),
  }
  const criticalMissing: string[] = []
  const optionalMissing: string[] = []
  let score = 0.30 // exact baseModel, already gated above

  if (recipe.hair === undefined) score += 0.24
  else if (hasPart(pack, recipe.baseModel, 'hair', recipe.hair)) score += 0.24
  else criticalMissing.push(`hair:${recipe.hair}`)

  if (recipe.outfit === undefined) score += 0.20
  else if (hasPart(pack, recipe.baseModel, 'outfit', recipe.outfit)) score += 0.20
  else criticalMissing.push(`outfit:${recipe.outfit}`)

  const requestedColours: Array<[AvatarMaterialSlotId, string | undefined]> = [
    ['skin', recipe.skinTone],
    ['hair', recipe.hairColor],
    ['outfit', recipe.outfitColor],
    ['accent', recipe.accentColor],
  ]
  const colourRequests = requestedColours.filter(([, value]) => value !== undefined)
  if (colourRequests.length === 0) score += 0.16
  else {
    const matched = colourRequests.filter(([slot]) => materialNamesFor(pack, slot).length > 0).length
    score += 0.16 * matched / colourRequests.length
    for (const [slot, value] of colourRequests) {
      if (materialNamesFor(pack, slot).length === 0) optionalMissing.push(`${slot}:${value}`)
    }
  }

  const accessories = recipe.accessoryIds ?? []
  if (accessories.length === 0) score += 0.10
  else {
    const matched = accessories.filter((id) => hasPart(pack, recipe.baseModel, 'accessory', id)).length
    score += 0.10 * matched / accessories.length
    for (const id of accessories) {
      if (!hasPart(pack, recipe.baseModel, 'accessory', id)) optionalMissing.push(`accessory:${id}`)
    }
  }

  const normalized = Math.min(1, Math.max(0, Number(score.toFixed(4))))
  return {
    pack,
    plan,
    score: normalized,
    criticalMissing,
    optionalMissing,
    eligible: criticalMissing.length === 0 && normalized >= MIN_PRODUCTION_AVATAR_IDENTITY_SCORE,
  }
}

function identityVisibleMeshes(pack: AvatarBasePackManifest, recipe: AvatarRecipe): string[] {
  const requests: Record<AvatarPartKind, Set<string>> = {
    hair: new Set(recipe.hair === undefined ? [] : [recipe.hair]),
    outfit: new Set(recipe.outfit === undefined ? [] : [recipe.outfit]),
    accessory: new Set(recipe.accessoryIds ?? []),
  }
  const visible = pack.parts
    .filter((part) => part.compatibleBaseModels === undefined || part.compatibleBaseModels.includes(recipe.baseModel))
    .filter((part) => requests[part.kind].has(part.id))
    .flatMap((part) => part.meshNames)
  return [...new Set(visible)]
}

function hasPart(
  pack: AvatarBasePackManifest,
  baseModel: AvatarBaseModel,
  kind: AvatarPartKind,
  id: string,
): boolean {
  return pack.parts.some((part) => part.kind === kind
    && part.id === id
    && (part.compatibleBaseModels === undefined || part.compatibleBaseModels.includes(baseModel)))
}

function compareMatches(left: AvatarPackIdentityMatch, right: AvatarPackIdentityMatch): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
  if (left.score !== right.score) return right.score - left.score
  if (left.pack.id !== right.pack.id) return left.pack.id.localeCompare(right.pack.id)
  return right.pack.version.localeCompare(left.pack.version, undefined, { numeric: true, sensitivity: 'base' })
}

function recipeFingerprint(recipe: AvatarRecipe): string {
  return [
    recipe.baseModel,
    recipe.build ?? '',
    recipe.hair ?? '',
    recipe.hairColor ?? '',
    recipe.skinTone ?? '',
    recipe.outfit ?? '',
    recipe.outfitColor ?? '',
    recipe.accentColor ?? '',
    ...(recipe.accessoryIds ?? []),
  ].join('|')
}
