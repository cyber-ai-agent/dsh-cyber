import type { EmployeeBlueprint, IsoTimestamp, WorkSession } from './index.js'

export interface EmbodimentSocialPolicy {
  canInitiateConversation: boolean
  cooldownSeconds: number
  maxDailyConversations: number
}

/**
 * Portable semantic description of a role's body in any compatible world.
 * It intentionally contains no coordinates, paths or animation frame numbers.
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

export type EmbodiedEmployeeBlueprint = EmployeeBlueprint & {
  embodiment?: EmbodimentProfile
}

export interface WorkshopRoleDefinition {
  id: string
  displayName: string
  role: string
  summary: string
  persona: string
  embodiment: EmbodimentProfile
  skillIds: string[]
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

export interface CharacterSkillAction {
  id: string
  worldId: string
  characterId: string
  skillId: string
  action: string
  target: string
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
