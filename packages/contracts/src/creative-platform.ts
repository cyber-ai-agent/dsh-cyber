import type { EmployeeBlueprint, IsoTimestamp, JsonObject, WorkSession } from './index.js'
import type { EmbodimentProfile } from './embodiment.js'

export type {
  EmbodimentPresetDescriptor,
  EmbodimentProfile,
  EmbodimentSocialPolicy,
} from './embodiment.js'

/**
 * Compatibility alias kept while callers migrate from the original Workshop
 * contract. Embodiment is now part of the core EmployeeBlueprint itself.
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
}

export type SkillActionStatus =
  | 'scheduled'
  | 'executed'
  | 'waiting-for-integration'
  | 'failed'

export type SkillActionRisk = 'read' | 'write-local' | 'external-side-effect'

export type SkillActionAuthorization =
  | 'explicit-user-request'
  | 'preapproved-policy'

/**
 * Durable, provider-neutral representation of one concrete skill side effect.
 * Adapter-specific credentials never belong here; parameters must be secret-free.
 */
export interface CharacterSkillAction {
  id: string
  worldId: string
  characterId: string
  skillId: string
  adapterId: string
  action: string
  target: string
  label: string
  risk: SkillActionRisk
  authorization: SkillActionAuthorization
  parameters: JsonObject
  scheduledFor?: IsoTimestamp
  status: SkillActionStatus
  detail: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface CharacterSkillResult {
  handled: boolean
  skillId?: string
  summary?: string
  actions: CharacterSkillAction[]
}

export interface CharacterSkillDescriptor {
  id: string
  displayName: string
  summary: string
  adapterId: string
  risks: SkillActionRisk[]
  supportsScheduling: boolean
}
