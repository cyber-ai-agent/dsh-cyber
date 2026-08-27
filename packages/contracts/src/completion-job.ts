import type { IsoTimestamp, JsonObject } from './index.js'

export type CompletionJobStatus = 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled'

export interface CompletionJob {
  id: string
  idempotencyKey: string
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  agentRunId: string
  type: string
  payload: JsonObject
  status: CompletionJobStatus
  attemptCount: number
  availableAt: IsoTimestamp
  leaseOwner?: string
  leaseExpiresAt?: IsoTimestamp
  lastErrorCode?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface CompletionJobDraft {
  idempotencyKey: string
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  agentRunId: string
  type: string
  payload: JsonObject
}
