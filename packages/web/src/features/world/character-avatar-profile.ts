import type { CharacterAvatarProfile, JsonValue } from '@dsh-cyber/contracts'

export const CHARACTER_AVATAR_APPEARANCE_KEY = 'digitalHumanAvatar'

export function readCharacterAvatarProfile(value: JsonValue | undefined): CharacterAvatarProfile | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, JsonValue>
  if (candidate.schemaVersion !== 1) return undefined
  if (typeof candidate.identityId !== 'string') return undefined
  if (candidate.rendererKind !== 'image-2d' && candidate.rendererKind !== 'vrm-3d') return undefined
  if (typeof candidate.assetId !== 'string' || typeof candidate.sourceName !== 'string' || typeof candidate.publishedAt !== 'string') return undefined
  if (typeof candidate.fallbackAvatarIndex !== 'number' || !Number.isInteger(candidate.fallbackAvatarIndex) || candidate.fallbackAvatarIndex < 0 || candidate.fallbackAvatarIndex > 7) return undefined
  if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((capability) => typeof capability !== 'string')) return undefined
  return candidate as unknown as CharacterAvatarProfile
}

export function characterAvatarUrl(profile: CharacterAvatarProfile | undefined): string | undefined {
  return profile === undefined ? undefined : `/api/assets/${encodeURIComponent(profile.assetId)}`
}
