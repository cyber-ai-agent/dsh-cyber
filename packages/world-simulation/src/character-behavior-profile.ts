import type { JsonObject, JsonValue } from '@dsh-cyber/contracts'
import type { CharacterBehaviorProfile } from '@dsh-cyber/contracts/world-simulation'

export const CHARACTER_BEHAVIOR_PROFILE_APPEARANCE_KEY = 'worldBehaviorProfile'

const DEFAULT_ALLOWED_ZONE_TAGS = [
  'administration',
  'engineering',
  'research',
  'operations',
  'meeting',
  'rest',
  'public',
  'custom',
]

/**
 * Decodes an explicit semantic profile supplied by a user or community role.
 *
 * The profile contains semantic tags only. It never contains coordinates,
 * anchor ids, paths or animation frames, so the same role can be reused by
 * unrelated world themes that map those tags to different facilities.
 */
export function parseCharacterBehaviorProfile(
  value: JsonValue | undefined,
): CharacterBehaviorProfile | undefined {
  if (value === undefined || value === null) return undefined
  const record = objectValue(value, 'worldBehaviorProfile')
  const id = requiredString(record['id'], 'worldBehaviorProfile.id')
  const roleTags = requiredStringArray(record['roleTags'], 'worldBehaviorProfile.roleTags')
  const preferredZoneTags = requiredStringArray(
    record['preferredZoneTags'],
    'worldBehaviorProfile.preferredZoneTags',
  )
  const preferredFacilityCapabilities = optionalStringArray(
    record['preferredFacilityCapabilities'],
    'worldBehaviorProfile.preferredFacilityCapabilities',
  )
  const allowedZoneTags = record['allowedZoneTags'] === undefined
    ? [...DEFAULT_ALLOWED_ZONE_TAGS]
    : requiredStringArray(record['allowedZoneTags'], 'worldBehaviorProfile.allowedZoneTags')
  const homeSlotTags = requiredStringArray(record['homeSlotTags'], 'worldBehaviorProfile.homeSlotTags')
  const ambientBehaviors = optionalStringArray(
    record['ambientBehaviors'],
    'worldBehaviorProfile.ambientBehaviors',
  )
  const social = record['socialPolicy'] === undefined
    ? undefined
    : objectValue(record['socialPolicy'], 'worldBehaviorProfile.socialPolicy')

  return {
    id,
    roleTags,
    preferredZoneTags,
    preferredFacilityCapabilities,
    allowedZoneTags,
    homeSlotTags,
    ambientBehaviors,
    socialPolicy: {
      canInitiateConversation: optionalBoolean(
        social?.['canInitiateConversation'],
        'worldBehaviorProfile.socialPolicy.canInitiateConversation',
      ) ?? false,
      cooldownSeconds: boundedInteger(
        social?.['cooldownSeconds'],
        'worldBehaviorProfile.socialPolicy.cooldownSeconds',
        0,
        86_400,
      ) ?? 1_800,
      maxDailyConversations: boundedInteger(
        social?.['maxDailyConversations'],
        'worldBehaviorProfile.socialPolicy.maxDailyConversations',
        0,
        100,
      ) ?? 0,
    },
  }
}

/**
 * Reads a persisted profile defensively. Invalid legacy or manually edited
 * values fall back to inferred/general behavior instead of breaking a world.
 * API writes should call assertCharacterBehaviorProfileAppearance first.
 */
export function readCharacterBehaviorProfile(
  appearance: JsonObject | undefined,
): CharacterBehaviorProfile | undefined {
  try {
    return parseCharacterBehaviorProfile(appearance?.[CHARACTER_BEHAVIOR_PROFILE_APPEARANCE_KEY])
  } catch {
    return undefined
  }
}

export function assertCharacterBehaviorProfileAppearance(appearance: JsonObject): void {
  parseCharacterBehaviorProfile(appearance[CHARACTER_BEHAVIOR_PROFILE_APPEARANCE_KEY])
}

export function characterBehaviorProfileToJson(profile: CharacterBehaviorProfile): JsonObject {
  return {
    id: profile.id,
    roleTags: [...profile.roleTags],
    preferredZoneTags: [...profile.preferredZoneTags],
    preferredFacilityCapabilities: [...profile.preferredFacilityCapabilities],
    allowedZoneTags: [...profile.allowedZoneTags],
    homeSlotTags: [...profile.homeSlotTags],
    ambientBehaviors: [...profile.ambientBehaviors],
    socialPolicy: {
      canInitiateConversation: profile.socialPolicy.canInitiateConversation,
      cooldownSeconds: profile.socialPolicy.cooldownSeconds,
      maxDailyConversations: profile.socialPolicy.maxDailyConversations,
    },
  }
}

function objectValue(value: JsonValue, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value
}

function requiredString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 120) throw new Error(`${path} must contain 1 to 120 characters`)
  return normalized
}

function requiredStringArray(value: JsonValue | undefined, path: string): string[] {
  const result = optionalStringArray(value, path)
  if (result.length === 0) throw new Error(`${path} must contain at least one semantic tag`)
  return result
}

function optionalStringArray(value: JsonValue | undefined, path: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  if (value.length > 32) throw new Error(`${path} cannot contain more than 32 tags`)
  const result = value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${path}[${index}] must be a string`)
    const normalized = item.trim().toLocaleLowerCase()
    if (!normalized || normalized.length > 64) {
      throw new Error(`${path}[${index}] must contain 1 to 64 characters`)
    }
    return normalized
  })
  if (new Set(result).size !== result.length) throw new Error(`${path} must not contain duplicate tags`)
  return result
}

function optionalBoolean(value: JsonValue | undefined, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function boundedInteger(
  value: JsonValue | undefined,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
