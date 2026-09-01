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
  /** Host-owned assignment reference; never copied into the generated Blueprint. */
  modelProfileId?: string
}

export type WorkshopProjectStatus = 'active' | 'archived'

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
  worldModelProfileId?: string
  /**
   * Added after the first release. Projects written by an older build have no
   * status on disk and are loaded as 'active'; the field is additive so an
   * older build can still read a project written by this one.
   */
  status: WorkshopProjectStatus
  archivedAt?: IsoTimestamp
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/**
 * Read-time projection of a stored project. The world link is resolved on read
 * because project and world lifecycles are independent: a project whose world
 * no longer resolves is detached, which is a normal state and not an error.
 */
export interface WorkshopProjectView extends WorkshopProject {
  /** False once the referenced world no longer exists. */
  worldLinked: boolean
}

/** Result of permanently deleting a project. The world is never touched. */
export interface WorkshopProjectDeletion {
  projectId: string
  worldId: string
  /** Always true: deleting a project never deletes its world. */
  worldRetained: true
}

export interface WorkshopCreateInput {
  displayName: string
  baseTemplateId: string
  lore?: string
  scenario?: string
  worldModelProfileId?: string
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
