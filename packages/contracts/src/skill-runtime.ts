import type { IsoTimestamp, JsonObject } from './index.js'
import type { WorldCharacterPermission } from './world-authority.js'

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

/** The authority domain which is allowed to authorize a concrete action. */
export type SkillAuthorizationSource = 'skill-grant' | 'world-authority'

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
  /** Provider-neutral authorization provenance; omitted means skill-grant for legacy rows. */
  authorizationSource?: SkillAuthorizationSource
  /** World-local permission checked immediately before execution. */
  requiredWorldPermission?: WorldCharacterPermission
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
  /** Deterministic task-routing vocabulary; never includes provider internals. */
  routingHints?: string[]
  adapterId: string
  /** Optional immutable package binding for integration capabilities. */
  packageId?: string
  risks: SkillActionRisk[]
  supportsScheduling: boolean
  /** Whether a one-time decision may create a reusable exact-target policy. */
  persistentApproval: PersistentApprovalCapability
  /** Defaults to skill-grant. Only trusted host adapters may opt into world-authority. */
  authorizationSource?: SkillAuthorizationSource
  /** Declarative default for actions emitted by this descriptor. */
  requiredWorldPermission?: WorldCharacterPermission
  /** Declarative recipes shape how a character works; integrations can execute host actions. */
  kind?: 'recipe' | 'integration'
  /** Safe recipes may be selected by default during recruitment. External integrations never are. */
  recommendedByDefault?: boolean
}

/**
 * The source that made a skill discoverable to the host catalog.
 *
 * This is deliberately separate from `CharacterSkillDescriptor.kind`: a
 * trusted host adapter may expose an integration on behalf of a marketplace
 * package, while MCP discovery is workspace-scoped and builtin recipes are
 * globally provided by the host.
 */
export type SkillCatalogSource = 'builtin' | 'plugin' | 'mcp' | 'other'

/** The scope which owns the discovery record. */
export type SkillCatalogScope = 'builtin' | 'workspace' | 'world'

/** Availability of the entry in the scope used to build the catalog response. */
export type SkillCatalogAvailability = 'available' | 'unavailable'

/**
 * A provider-neutral, UI-safe view of one known Skill.
 *
 * `globalKnown` answers whether the host can identify the capability at all;
 * `worldAvailable` answers whether the current World may use it. The latter
 * is intentionally derived per request from World Package Instances (or the
 * explicit builtin/workspace scope), never persisted on the descriptor.
 */
export interface SkillCatalogEntry extends CharacterSkillDescriptor {
  source: SkillCatalogSource
  scope: SkillCatalogScope
  globalKnown: boolean
  worldAvailable: boolean
  availability: SkillCatalogAvailability
  packageId?: string
  packageVersion?: string
}
