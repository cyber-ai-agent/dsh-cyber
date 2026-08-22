import type { IsoTimestamp, JsonObject } from './index.js'

export const PEER_COLLABORATION_CONTRACT_VERSION = 1 as const

export interface PeerConversationPolicy {
  maxTurns: number
  timeoutMs: number
  cooldownSeconds: number
  maxPromptCharsPerTurn: number
  maxResponseCharsPerTurn: number
}

export interface PeerConversationIntent {
  contractVersion: typeof PEER_COLLABORATION_CONTRACT_VERSION
  workspaceId: string
  worldId: string
  initiatorId: string
  targetId: string
  purpose: string
  taskId?: string
  urgency: 'low' | 'normal' | 'high'
  requestedAt: IsoTimestamp
  metadata: JsonObject
}

export interface PeerConversationTurn {
  index: number
  speakerId: string
  listenerId: string
  content: string
  messageId: string
  createdAt: IsoTimestamp
}

export interface PeerConversationTranscript {
  sessionId: string
  intent: PeerConversationIntent
  turns: PeerConversationTurn[]
  startedAt: IsoTimestamp
  completedAt?: IsoTimestamp
}

export interface PeerConversationOutcome {
  sessionId: string
  status: 'completed' | 'blocked' | 'cancelled'
  summary: string
  participantIds: [string, string]
  sourceMessageIds: string[]
  sourceEventIds: string[]
  completedAt: IsoTimestamp
}

export const DEFAULT_PEER_CONVERSATION_POLICY: PeerConversationPolicy = {
  maxTurns: 4,
  timeoutMs: 90_000,
  cooldownSeconds: 300,
  maxPromptCharsPerTurn: 12_000,
  maxResponseCharsPerTurn: 8_000,
}
