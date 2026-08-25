import type { IsoTimestamp, JsonObject } from './index.js'

export type SkillActionStatus =
  | 'scheduled'
  | 'waiting-for-approval'
  | 'executed'
  | 'waiting-for-integration'
  | 'failed'
  | 'outcome-unknown'
  | 'rejected'

export type SkillActionRisk = 'read' | 'write-local' | 'external-side-effect'

export type SkillActionAuthorization =
  | 'explicit-user-request'
  | 'preapproved-policy'

export type SkillActionExecutionState = 'approved-ready' | 'executing' | 'settled'
export type PersistentApprovalCapability = 'forbidden' | 'exact-target'

/**
 * Durable, provider-neutral representation of one concrete Skill side effect.
 *
 * It contains no provider credentials and no executable callback. Provider
 * details stay behind a trusted host-side Skill Adapter.
 *
 * `outcome-unknown` is intentionally distinct from `failed`: once an external
 * request may have left the process, a lost response cannot prove that no side
 * effect happened. Unknown outcomes must never be auto-retried blindly.
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
  approvalRequestId?: string
  workTurnId?: string
  agentRunId?: string
  executionState?: SkillActionExecutionState
  executionAttemptId?: string
  executionStartedAt?: IsoTimestamp
  executionCompletedAt?: IsoTimestamp
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
  /** Whether a one-time decision may create a reusable exact-target policy. */
  persistentApproval: PersistentApprovalCapability
  /** Declarative recipes shape how a character works; integrations can execute host actions. */
  kind?: 'recipe' | 'integration'
  /** Safe recipes may be selected by default during recruitment. External integrations never are. */
  recommendedByDefault?: boolean
}
