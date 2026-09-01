import type { EmployeeMemoryScope, IsoTimestamp } from './index.js'
import type { ContextLayerKind } from './context-envelope.js'

/**
 * The Context Inspector projection (Magic Context V1, slice D3).
 *
 * This describes *the context structure this product built and sent* for one
 * turn — the layers, their sizes and the durable rows behind them. It is not,
 * and must never be presented as, the model's hidden chain of thought: nothing
 * here comes from the provider's internal reasoning, only from the envelope we
 * assembled ourselves.
 *
 * Everything text-shaped in this projection is already redacted and bounded by
 * the server before it is built. The inspector therefore never holds a raw
 * layer body, which is what keeps a credential that a user pasted into a chat
 * from travelling any further than the conversation it was pasted into.
 */

/**
 * Whether a prompt cache took part in this turn.
 *
 * `unavailable` is the honest default: no cache runtime reported anything, so
 * the inspector says so instead of inventing a hit rate. It is the seam the
 * prompt-cache slice fills in — nothing else in this module needs to change
 * when real statistics start arriving.
 */
export type ContextCacheState = 'unavailable' | 'disabled' | 'hit' | 'miss'

export interface ContextCacheInspection {
  state: ContextCacheState
  /** Prefix tokens the provider served from cache, when it reported them. */
  cachedTokens?: number
  /** Tokens that had to be sent uncached, when the runtime reported them. */
  uncachedTokens?: number
  /** Cache identity of the prefix, so two turns can be compared by eye. */
  stableContextHash?: string
}

export interface ContextLayerInspection {
  kind: ContextLayerKind
  id: string
  /** Source revision when the layer has one; otherwise its content hash. */
  revision: string
  contentHash: string
  tokenEstimate: number
  /** Durable rows this layer was derived from. */
  sourceCount: number
  /** Redacted, bounded excerpt of what the layer contributed. */
  preview: string
  /** True when `preview` is shorter than the layer text it came from. */
  previewTruncated: boolean
}

export interface ContextMemoryHitInspection {
  /** The durable milestone id; it relocates the original messages. */
  memoryId: string
  scope: EmployeeMemoryScope
  score: number
  /** Why retrieval chose this memory, in readable Chinese. */
  reason: string
  occurredAt: IsoTimestamp
  sourceMessageCount: number
  artifactCount: number
  /** Redacted, bounded excerpt of the remembered summary. */
  summary: string
}

export interface ContextBudgetInspection {
  contextWindow?: number
  inputBudgetTokens?: number
  memoryTokens?: number
  historyTokens?: number
}

/**
 * What the composer could and could not cover this turn.
 *
 * These are the numbers that explain a surprising context: a conversation that
 * still replays in full, or one that dropped older turns because retrieval can
 * bring them back.
 */
export interface ContextCoverageInspection {
  memoryScopes: EmployeeMemoryScope[]
  rawEntryCount: number
  droppedOlderEntryCount: number
  unrememberedRawEntryCount: number
  hydratedMemoryCount: number
  hydratedSourceMessageCount: number
  rawWindowApplied: boolean
  fullReplayFallback: boolean
}

export interface ContextInspection {
  conversationId: string
  employeeId: string
  employeeName: string
  /** When this context was composed for a turn. */
  capturedAt: IsoTimestamp
  lane: 'direct' | 'group' | 'task' | 'unknown'
  workTurnId?: string
  /** Sum of the layer estimates; the composer's own arithmetic, not the provider's. */
  usedTokens: number
  budget: ContextBudgetInspection
  layers: ContextLayerInspection[]
  memoryHits: ContextMemoryHitInspection[]
  cache: ContextCacheInspection
  coverage: ContextCoverageInspection
}

export interface ContextInspectionResponse {
  /** `undefined` when no turn has been composed for this conversation yet. */
  inspection?: ContextInspection
}
