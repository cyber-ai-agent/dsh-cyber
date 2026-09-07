import type {
  AgentPermissionMode,
  IsoTimestamp,
  JsonObject,
  ReasoningEffort,
  WorkMessage,
  WorkSession,
  WorkTurn,
  WorkTurnInteractionKind,
} from './index.js'
import type { ConversationQueueEntry } from './conversation-queue.js'
import type { WorkSessionCollaborationMode } from './task-collaboration.js'

/** The session kinds that can receive an owner chat submission. */
export type ConversationSubmissionSessionKind = Extract<WorkSession['kind'], 'direct' | 'group'>

/** Queue options written together with a submission, when the caller queues it. */
export interface ConversationSubmissionQueueInput {
  id?: string
  employeeIds: string[]
  /** The durable queue ordering request; `next` is resolved in the transaction. */
  queueMode?: 'normal' | 'next'
  collaborationMode?: WorkSessionCollaborationMode
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  priority?: number
}

/**
 * The structured, transient input from which the server derives a submission
 * fingerprint. The prompt contributes only its digest to the durable claim.
 */
export interface ConversationSubmissionFingerprintSource {
  sessionId?: string
  sessionKind: ConversationSubmissionSessionKind
  participantEmployeeIds: readonly string[]
  /** The employees the host actually reserves after planning/routing. */
  reservationEmployeeIds?: readonly string[]
  interactionKind: WorkTurnInteractionKind
  collaborationMode?: WorkSessionCollaborationMode
  prompt: string
  /** One-turn model overrides, including per-character group overrides. */
  modelProfileId?: string
  modelProfileIds?: Readonly<Record<string, string>>
  /** Stable attachment metadata; URLs and file contents are intentionally absent. */
  attachments?: ReadonlyArray<{
    assetId: string
    name: string
    mimeType: string
    byteLength: number
    sha256?: string
  }>
  /** Host-produced routing/planning fields after sensitive text has been removed. */
  planningFingerprint?: JsonObject
  queue?: ConversationSubmissionQueueInput
}

/**
 * One atomic owner submission. `idempotencyKey` is the caller supplied retry
 * key; `fingerprintSha256` is the SHA-256 of normalized structured request
 * fields, never the raw prompt itself.
 */
export interface ConversationSubmissionInput {
  workspaceId: string
  worldId: string
  idempotencyKey: string
  fingerprintSha256: string
  sessionId?: string
  sessionKind: ConversationSubmissionSessionKind
  sessionTitle?: string
  participantEmployeeIds: string[]
  reservationEmployeeIds?: string[]
  interactionKind: WorkTurnInteractionKind
  collaborationMode?: WorkSessionCollaborationMode
  modelProfileId?: string
  modelProfileIds?: Readonly<Record<string, string>>
  attachments?: Array<{
    assetId: string
    name: string
    mimeType: string
    byteLength: number
    sha256?: string
  }>
  planningFingerprint?: JsonObject
  ownerMessage: {
    content: string
    metadata?: JsonObject
    causationId?: string
    correlationId?: string
  }
  queue?: ConversationSubmissionQueueInput
}

/** Durable identity and scope of the one accepted submission. */
export interface ConversationSubmissionClaim {
  id: string
  workspaceId: string
  worldId: string
  idempotencyKey: string
  fingerprintSha256: string
  sessionId: string
  workTurnId: string
  ownerMessageId: string
  queueEntryId?: string
  createdAt: IsoTimestamp
}

/** Existing facts returned for both a first claim and a safe replay. */
export interface ConversationSubmissionReceipt {
  claim: ConversationSubmissionClaim
  session: WorkSession
  workTurn: WorkTurn
  ownerMessage: WorkMessage
  queueEntry?: ConversationQueueEntry
}

/** `created` is false when the exact claim was already persisted. */
export interface ConversationSubmissionResult extends ConversationSubmissionReceipt {
  created: boolean
}
