import type {
  CharacterBlueprintDraft,
  CharacterGeneratorAvatarCatalogItem,
  CharacterGeneratorCatalog,
  CharacterGeneratorCapabilityId,
  CharacterGeneratorPublishResult,
  CharacterSourceInput,
  EmbodimentProfile,
  World,
} from '@dsh-cyber/contracts'
import { normalizeSkillCatalogEntry } from '../skill-catalog.js'

export type CharacterGeneratorStep = 'source' | 'analysis' | 'preview' | 'publish'
export type CharacterGeneratorSourceMode = CharacterSourceInput['kind']

export interface CharacterGeneratorProps {
  workspaceId: string
  targetWorld: World
  onClose(): void
  onPublished(result: CharacterGeneratorPublishResult): Promise<void> | void
  closeRequest?: number
}

export const CHARACTER_SOURCE_MAX_BYTES = 128 * 1024
export const CHARACTER_AVATAR_MAX_BYTES = 5 * 1024 * 1024

export const EMPTY_CHARACTER_CATALOG: CharacterGeneratorCatalog = {
  skills: [],
  capabilities: [],
  avatars: [],
}

export function initialCharacterDraft(targetWorldTemplateId: string): CharacterBlueprintDraft {
  return {
    schemaVersion: 1,
    targetWorldTemplateId,
    displayName: '',
    role: '',
    summary: '',
    persona: '',
    personalityTraits: [],
    background: '',
    requestedSkillIds: [],
    requestedCapabilities: [],
    sourceSummary: '',
    sourceRefs: [],
  }
}

export function validateCharacterSource(source: CharacterSourceInput): string | undefined {
  const value = source.text.trim()
  if (value.length === 0) return 'source.empty'
  if (new TextEncoder().encode(value).byteLength > CHARACTER_SOURCE_MAX_BYTES) return 'source.tooLarge'
  if (source.kind === 'file') {
    const extension = source.fileName?.toLowerCase().split('.').pop()
    if (extension !== 'md' && extension !== 'txt') return 'source.fileInvalid'
  } else if (source.fileName !== undefined) {
    return 'source.fileInvalid'
  }
  return undefined
}

export function validateCharacterDraft(draft: CharacterBlueprintDraft, catalog?: CharacterGeneratorCatalog): string | undefined {
  if (draft.schemaVersion !== 1 || draft.targetWorldTemplateId.trim().length === 0) return 'draft.invalidVersion'
  if (draft.displayName.trim().length === 0) return 'draft.displayNameRequired'
  if (draft.displayName.trim().length > 100) return 'draft.displayNameTooLong'
  if (draft.role.trim().length === 0) return 'draft.roleRequired'
  if (draft.role.trim().length > 100) return 'draft.roleTooLong'
  if (draft.summary.trim().length === 0) return 'draft.summaryRequired'
  if (draft.summary.trim().length > 500) return 'draft.summaryTooLong'
  if (draft.persona.trim().length === 0) return 'draft.personaRequired'
  if (draft.persona.trim().length > 2_000) return 'draft.personaTooLong'
  if (draft.background.length > 4_000) return 'draft.backgroundTooLong'
  if (draft.personalityTraits.length > 20 || draft.personalityTraits.some((trait) => trait.trim().length > 80)) return 'draft.traitsTooLong'

  if (catalog !== undefined) {
    const skillIds = new Set(catalog.skills.map((skill) => skill.id))
    const capabilityIds = new Set(catalog.capabilities.map((capability) => capability.id))
    if (draft.requestedSkillIds.some((id) => !skillIds.has(id))) return 'draft.skillUnavailable'
    if (draft.requestedCapabilities.some((id) => !capabilityIds.has(id))) return 'draft.capabilityUnavailable'
  }
  return undefined
}

export function normalizeDraft(value: unknown, targetWorldTemplateId: string): CharacterBlueprintDraft {
  const record = isRecord(value) ? value : {}
  const traits = readStringArray(record.personalityTraits ?? record.traits ?? record.personality)
  const requestedSkillIds = readStringArray(record.requestedSkillIds ?? record.requestedSkills ?? record.skills)
  const requestedCapabilities = readStringArray(record.requestedCapabilities ?? record.capabilities).filter(isCapabilityId)
  const embodiment = normalizeEmbodiment(record.embodiment)
  return {
    schemaVersion: 1,
    targetWorldTemplateId: readString(record.targetWorldTemplateId) || targetWorldTemplateId,
    displayName: readString(record.displayName ?? record.name),
    role: readString(record.role ?? record.title),
    summary: readString(record.summary ?? record.description),
    persona: readString(record.persona ?? record.systemPrompt),
    personalityTraits: traits,
    background: readString(record.background),
    requestedSkillIds: unique(requestedSkillIds),
    requestedCapabilities: uniqueCapabilities(requestedCapabilities),
    ...(embodiment === undefined ? {} : { embodiment }),
    sourceSummary: readString(record.sourceSummary ?? record.analysisSummary),
    sourceRefs: unique(readStringArray(record.sourceRefs ?? record.references)),
  }
}

export function normalizeCatalog(value: unknown): CharacterGeneratorCatalog {
  const root = isRecord(value) && isRecord(value.catalog) ? value.catalog : value
  const record = isRecord(root) ? root : {}
  const skills = readArray(record.skills ?? record.skillCatalog).map(normalizeSkillCatalogEntry).filter(isDefined)
  const capabilities = readArray(record.capabilities ?? record.capabilityCatalog).map(normalizeCapability).filter(isDefined)
  const avatars = readArray(record.avatars ?? record.avatarCatalog).map(normalizeAvatar).filter(isDefined)
  return { skills, capabilities, avatars }
}

export function trimDraft(draft: CharacterBlueprintDraft): CharacterBlueprintDraft {
  return {
    ...draft,
    schemaVersion: 1,
    targetWorldTemplateId: draft.targetWorldTemplateId.trim(),
    displayName: draft.displayName.trim(),
    role: draft.role.trim(),
    summary: draft.summary.trim(),
    persona: draft.persona.trim(),
    background: draft.background.trim(),
    personalityTraits: unique(draft.personalityTraits.map((trait) => trait.trim()).filter(Boolean)),
    requestedSkillIds: unique(draft.requestedSkillIds.filter(Boolean)),
    requestedCapabilities: uniqueCapabilities(draft.requestedCapabilities.filter(Boolean)),
    sourceSummary: draft.sourceSummary.trim(),
    sourceRefs: unique(draft.sourceRefs.filter(Boolean)),
  }
}

function normalizeCapability(value: unknown): CharacterGeneratorCatalog['capabilities'][number] | undefined {
  if (!isRecord(value) || !isCapabilityId(value.id)) return undefined
  return {
    id: value.id,
    displayName: readString(value.displayName ?? value.name) || value.id,
    summary: readString(value.summary ?? value.description),
  }
}

function normalizeAvatar(value: unknown): CharacterGeneratorAvatarCatalogItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.packageId !== 'string' || typeof value.packageVersion !== 'string' || typeof value.previewPath !== 'string') return undefined
  if (value.mimeType !== 'image/png' && value.mimeType !== 'image/jpeg' && value.mimeType !== 'image/webp') return undefined
  return {
    id: value.id,
    displayName: readString(value.displayName ?? value.name) || value.id,
    ...(typeof value.label === 'string' && value.label.length > 0 ? { label: value.label } : {}),
    packageId: value.packageId,
    packageVersion: value.packageVersion,
    previewPath: value.previewPath,
    mimeType: value.mimeType,
    source: 'builtin',
  } as CharacterGeneratorAvatarCatalogItem
}

function normalizeEmbodiment(value: unknown): EmbodimentProfile | undefined {
  if (!isRecord(value)) return undefined
  const profile: EmbodimentProfile = {
    roleTags: readStringArray(value.roleTags),
    preferredZoneTags: readStringArray(value.preferredZoneTags),
    preferredFacilityCapabilities: readStringArray(value.preferredFacilityCapabilities),
    allowedZoneTags: readStringArray(value.allowedZoneTags),
    homeSlotTags: readStringArray(value.homeSlotTags),
    ambientBehaviors: readStringArray(value.ambientBehaviors),
  }
  if (typeof value.actorRigId === 'string' && value.actorRigId.length > 0) profile.actorRigId = value.actorRigId
  if (isRecord(value.socialPolicy)) {
    const cooldownSeconds = value.socialPolicy.cooldownSeconds
    const maxDailyConversations = value.socialPolicy.maxDailyConversations
    if (typeof value.socialPolicy.canInitiateConversation === 'boolean' && typeof cooldownSeconds === 'number' && typeof maxDailyConversations === 'number') {
      profile.socialPolicy = { canInitiateConversation: value.socialPolicy.canInitiateConversation, cooldownSeconds, maxDailyConversations }
    }
  }
  return profile
}

function isCapabilityId(value: unknown): value is CharacterGeneratorCapabilityId {
  return value === 'workspace:read' || value === 'knowledge:read' || value === 'artifact:read'
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function uniqueCapabilities(values: CharacterGeneratorCapabilityId[]): CharacterGeneratorCapabilityId[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
