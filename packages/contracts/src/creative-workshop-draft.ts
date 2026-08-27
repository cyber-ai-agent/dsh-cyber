export type ModelCapability = 'text' | 'vision' | 'reasoning' | 'tools' | 'image-generation' | 'embedding'

export type CreativeWorkshopDraftModelPolicy =
  | { mode: 'inherit' }
  | { mode: 'override'; modelProfileId?: string }
  | { mode: 'recommend'; requiredCapabilities: ModelCapability[]; reason: string }

export interface CreativeWorkshopWorldDraft {
  name: string
  description?: string
  purpose?: string
  themeHint?: string
  modelPolicy?: CreativeWorkshopDraftModelPolicy
}

export interface CreativeWorkshopCharacterDraft {
  /** Draft-only identity. The host generates the persistent character id. */
  tempId: string
  name: string
  role?: string
  summary?: string
  persona?: { traits?: string[]; communicationStyle?: string; background?: string }
  responsibilities?: string[]
  appearance?: { description?: string; avatarHint?: string; embodimentHint?: string }
  relationship?: { type?: string; description?: string }
  /** Suggestions only. This field can never become a Skill Grant implicitly. */
  requestedSkills?: string[]
  modelPolicy?: CreativeWorkshopDraftModelPolicy
  advanced?: {
    reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    requestedPermissions?: string[]
    ambientBehaviors?: string[]
  }
}

/** Stable intermediate protocol: editable and previewable, never executable. */
export interface CreativeWorkshopDraftV1 {
  schemaVersion: 1
  world: CreativeWorkshopWorldDraft
  characters: CreativeWorkshopCharacterDraft[]
  metadata?: { generatedBy?: string; generatedAt?: string; originalPrompt?: string }
}
