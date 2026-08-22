import type { EmbodimentProfile } from '@dsh-cyber/contracts/creative-platform'

const TAG = /^[a-z][a-z0-9._-]{0,63}$/
const RIG = /^[a-z0-9][a-z0-9._/-]{0,127}$/

export function parseEmbodimentProfile(value: unknown, label = 'embodiment'): EmbodimentProfile {
  const input = object(value, label)
  const allowed = new Set([
    'roleTags',
    'preferredZoneTags',
    'preferredFacilityCapabilities',
    'allowedZoneTags',
    'homeSlotTags',
    'ambientBehaviors',
    'actorRigId',
    'socialPolicy',
  ])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} field: ${key}`)
  }
  const social = input.socialPolicy === undefined ? undefined : object(input.socialPolicy, `${label}.socialPolicy`)
  if (social !== undefined) {
    for (const key of Object.keys(social)) {
      if (!['canInitiateConversation', 'cooldownSeconds', 'maxDailyConversations'].includes(key)) {
        throw new Error(`Unknown ${label}.socialPolicy field: ${key}`)
      }
    }
  }
  const result: EmbodimentProfile = {
    roleTags: tags(input.roleTags, `${label}.roleTags`, true),
    preferredZoneTags: tags(input.preferredZoneTags, `${label}.preferredZoneTags`, true),
    preferredFacilityCapabilities: tags(input.preferredFacilityCapabilities, `${label}.preferredFacilityCapabilities`, false),
    allowedZoneTags: tags(input.allowedZoneTags, `${label}.allowedZoneTags`, true),
    homeSlotTags: tags(input.homeSlotTags, `${label}.homeSlotTags`, true),
    ambientBehaviors: tags(input.ambientBehaviors, `${label}.ambientBehaviors`, false),
  }
  const actorRigId = optionalString(input.actorRigId, `${label}.actorRigId`, RIG)
  if (actorRigId !== undefined) result.actorRigId = actorRigId
  if (social !== undefined) {
    result.socialPolicy = {
      canInitiateConversation: boolean(social.canInitiateConversation, `${label}.socialPolicy.canInitiateConversation`, false),
      cooldownSeconds: integer(social.cooldownSeconds, `${label}.socialPolicy.cooldownSeconds`, 0, 86_400, 1_800),
      maxDailyConversations: integer(social.maxDailyConversations, `${label}.socialPolicy.maxDailyConversations`, 0, 100, 0),
    }
  }
  return result
}

export function embodimentToBehaviorJson(id: string, profile: EmbodimentProfile): Record<string, unknown> {
  return {
    id,
    roleTags: profile.roleTags,
    preferredZoneTags: profile.preferredZoneTags,
    preferredFacilityCapabilities: profile.preferredFacilityCapabilities,
    allowedZoneTags: profile.allowedZoneTags,
    homeSlotTags: profile.homeSlotTags,
    ambientBehaviors: profile.ambientBehaviors,
    socialPolicy: profile.socialPolicy ?? {
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    },
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function tags(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > 32) throw new Error(`${label} must be an array with at most 32 tags`)
  const result = value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${label}[${index}] must be a string`)
    const normalized = item.trim().toLowerCase()
    if (!TAG.test(normalized)) throw new Error(`Invalid semantic tag at ${label}[${index}]`)
    return normalized
  })
  if (required && result.length === 0) throw new Error(`${label} must contain at least one tag`)
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate tags`)
  return result
}

function optionalString(value: unknown, label: string, pattern: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw new Error(`Invalid ${label}`)
  return value.trim()
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function integer(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return value
}
