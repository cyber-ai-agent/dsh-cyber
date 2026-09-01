import type { CyberMarketPackage, EmployeeBlueprint } from './index.js'
import type { EmbodimentProfile } from './embodiment.js'
import type { SkillCatalogEntry } from './skill-runtime.js'

/** User-provided material that is analyzed as untrusted input. */
export type CharacterSourceKind = 'description' | 'file' | 'paste'

export interface CharacterSourceInput {
  kind: CharacterSourceKind
  text: string
  fileName?: string
}

/** A review-only character suggestion. It is not a persisted Employee. */
export interface CharacterBlueprintDraft {
  schemaVersion: 1
  targetWorldTemplateId: string
  displayName: string
  role: string
  summary: string
  persona: string
  personalityTraits: string[]
  background: string
  requestedSkillIds: string[]
  requestedCapabilities: CharacterGeneratorCapabilityId[]
  embodiment?: EmbodimentProfile
  sourceSummary: string
  sourceRefs: string[]
}

export type CharacterGeneratorCapabilityId =
  | 'workspace:read'
  | 'knowledge:read'
  | 'artifact:read'

export interface CharacterGeneratorCapabilityCatalogItem {
  id: CharacterGeneratorCapabilityId
  displayName: string
  summary: string
}

export type CharacterGeneratorAvatarMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

/** A host-approved preview source; arbitrary package files are not admitted. */
export interface CharacterGeneratorAvatarCatalogItem {
  id: string
  displayName: string
  avatarIndex: number
  label?: string
  packageId: string
  packageVersion: string
  previewPath: string
  mimeType: CharacterGeneratorAvatarMimeType
  source: 'builtin'
}

export interface CharacterGeneratorCatalog {
  capabilities: CharacterGeneratorCapabilityCatalogItem[]
  avatars: CharacterGeneratorAvatarCatalogItem[]
  skills: SkillCatalogEntry[]
}

export interface CharacterImportAnalyzeInput {
  workspaceId: string
  targetWorldTemplateId: string
  source: CharacterSourceInput
}

export interface CharacterImportAnalyzeResult {
  draft: CharacterBlueprintDraft
}

export type CharacterImportAnalyzeRequest = CharacterImportAnalyzeInput
export type CharacterGeneratorAnalyzeInput = CharacterImportAnalyzeInput
export type CharacterGeneratorAnalyzeResult = CharacterImportAnalyzeResult

export type CharacterGeneratorAvatarSelection =
  | { kind: 'builtin'; id: string }
  | {
      kind: 'upload'
      fileName: string
      mimeType: CharacterGeneratorAvatarMimeType
      dataBase64: string
    }

export interface CharacterImportPublishInput {
  workspaceId: string
  targetWorldTemplateId: string
  draft: CharacterBlueprintDraft
  source: CharacterSourceInput
  avatar?: CharacterGeneratorAvatarSelection
}

export interface CharacterImportPublishResult {
  item: CyberMarketPackage
  blueprint: EmployeeBlueprint
}

export type CharacterImportPublishRequest = CharacterImportPublishInput
export type CharacterGeneratorPublishInput = CharacterImportPublishInput
export type CharacterGeneratorPublishResult = CharacterImportPublishResult

// Short aliases keep the contract convenient for host-side callers while the
// CharacterImport* names remain the wire-facing terminology.
export type CharacterGeneratorCapability = CharacterGeneratorCapabilityCatalogItem
export type CharacterGeneratorAvatar = CharacterGeneratorAvatarCatalogItem
