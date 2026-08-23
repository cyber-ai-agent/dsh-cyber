export interface EmbodimentSocialPolicy {
  canInitiateConversation: boolean
  cooldownSeconds: number
  maxDailyConversations: number
}

/**
 * Portable semantic description of a character body and world behavior.
 *
 * It intentionally contains no pixel coordinates, concrete paths or animation
 * frame numbers. A compatible world/theme resolves these semantic tags to its
 * own zones, facilities, slots and renderer assets.
 */
export interface EmbodimentProfile {
  roleTags: string[]
  preferredZoneTags: string[]
  preferredFacilityCapabilities: string[]
  allowedZoneTags: string[]
  homeSlotTags: string[]
  ambientBehaviors: string[]
  actorRigId?: string
  socialPolicy?: EmbodimentSocialPolicy
}

/**
 * Human-facing reusable starting point for EmbodimentProfile authoring.
 * Presets are catalog data rather than UI conditionals. Users may still author
 * an explicit semantic profile that does not match any preset.
 */
export interface EmbodimentPresetDescriptor {
  id: string
  displayName: string
  description: string
  profile: EmbodimentProfile
}
