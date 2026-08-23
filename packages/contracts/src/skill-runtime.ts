import type { IsoTimestamp, JsonObject } from './index.js'

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
 * Durable, provider-neutral representation of one concrete Skill side effect.
 *
 * It contains no provider credentials and no executable callback. Provider
 * details stay behind a trusted host-side Skill Adapter.
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

/** Host-visible description of a Skill capability exposed by an Adapter. */
export interface CharacterSkillDescriptor {
  id: string
  displayName: string
  summary: string
  adapterId: string
  risks: SkillActionRisk[]
  supportsScheduling: boolean
}
