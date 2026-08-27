import type { EmployeeBlueprint, IsoTimestamp, WorkSession } from './index.js'
import type { EmbodimentProfile } from './embodiment.js'

export * from './creative-workshop-draft.js'

export type {
  EmbodimentPresetDescriptor,
  EmbodimentProfile,
  EmbodimentSocialPolicy,
} from './embodiment.js'

/**
 * @deprecated Embodiment is part of the core EmployeeBlueprint contract.
 * Kept temporarily for source compatibility with early Creative Platform code.
 */
export type EmbodiedEmployeeBlueprint = EmployeeBlueprint

export interface WorkshopRoleDefinition {
  id: string
  displayName: string
  role: string
  summary: string
  persona: string
  embodiment: EmbodimentProfile
  /** Capabilities the generated blueprint may request. Grants happen separately. */
  requestedSkillIds: string[]
}

export interface WorkshopProject {
  schemaVersion: 1
  id: string
  workspaceId: string
  worldId: string
  displayName: string
  baseTemplateId: string
  lore: string
  scenario: string
  roles: WorkshopRoleDefinition[]
  generatedPackageIds: string[]
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface WorkshopCreateInput {
  displayName: string
  baseTemplateId: string
  lore?: string
  scenario?: string
  roles: Array<Omit<WorkshopRoleDefinition, 'id'> & { id?: string }>
}

export interface ConversationHubItem {
  session: WorkSession
  participantIds: string[]
  pinned: boolean
  hidden: boolean
  canonicalCharacterId?: string
  /** Compact preview of the most recent owner prompt, capped server-side. */
  lastPrompt?: string
}

// Compatibility re-exports. Skill Runtime is a core host capability and must
// not depend on the Creative Workshop contract.
export type {
  CharacterSkillAction,
  CharacterSkillDescriptor,
  CharacterSkillResult,
  SkillCatalogAvailability,
  SkillCatalogEntry,
  SkillCatalogScope,
  SkillCatalogSource,
  SkillActionAuthorization,
  SkillActionRisk,
  SkillActionStatus,
} from './skill-runtime.js'
