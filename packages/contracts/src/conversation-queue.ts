import type {
  AgentPermissionMode,
  IsoTimestamp,
  ReasoningEffort,
  WorkSessionCollaborationMode,
  WorkSessionKind,
} from './index.js'

export type ConversationQueueEntryStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

/**
 * Durable queue metadata. The user prompt is intentionally absent: the
 * authoritative WorkTurn/session transcript owns conversational content.
 */
export interface ConversationQueueEntry {
  id: string
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  employeeIds: string[]
  conversationKind: WorkSessionKind
  collaborationMode?: WorkSessionCollaborationMode
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  priority: number
  revision: number
  status: ConversationQueueEntryStatus
  errorCode?: string
  enqueuedAt: IsoTimestamp
  claimedAt?: IsoTimestamp
  completedAt?: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type ConversationQueueItem = ConversationQueueEntry
