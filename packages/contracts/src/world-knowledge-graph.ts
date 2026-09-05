import type { IsoTimestamp, JsonObject } from './index.js'

/** Semantic node kinds kept intentionally generic so every world can use the graph. */
export type KnowledgeEntityType =
  | 'character'
  | 'person'
  | 'place'
  | 'organization'
  | 'project'
  | 'artifact'
  | 'technology'
  | 'concept'
  | 'tool'
  | 'process'
  | 'event'
  | 'topic'
  | 'object'
  | 'other'

export type KnowledgeEntityStatus = 'active' | 'archived'

export interface KnowledgeEntity {
  id: string
  workspaceId: string
  worldId: string
  type: KnowledgeEntityType
  canonicalName: string
  aliases: string[]
  summary: string
  status: KnowledgeEntityStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  archivedAt?: IsoTimestamp
}

export type KnowledgeClaimType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'rule'
  | 'definition'
  | 'procedure'
  | 'constraint'
  | 'insight'
  | 'lore'

export type KnowledgeStatementStatus = 'active' | 'conflicted' | 'superseded' | 'archived'
export type KnowledgeStatementSource = 'auto' | 'manual'

/**
 * Why a statement stopped being current, and which source revision it came
 * from.
 *
 * A statement carries this once every piece of evidence supporting it belongs
 * to content the world no longer holds — the document was rewritten, the
 * artifact was archived, the source was deleted. It is deliberately *not* a
 * status: the row keeps its own `status`, stays visible, stays attributed, and
 * is never removed, because the product must not destroy what the owner
 * gathered. What it does mean is that retrieval feeding a prompt must leave it
 * out: asserting a fact whose last live evidence is gone is the one thing the
 * graph may not do. The mark is cleared the moment live evidence supports the
 * statement again — re-extraction of the new revision, or the source version
 * becoming current once more.
 */
export interface KnowledgeNotCurrentMark {
  /** When the statement lost its last live supporting evidence. */
  since: IsoTimestamp
  sourceType: KnowledgeChunkedSourceType
  sourceId: string
  /** Version identity of the source revision it was last supported by. */
  contentHash: string
}

export interface KnowledgeClaim {
  id: string
  workspaceId: string
  worldId: string
  type: KnowledgeClaimType
  subjectEntityId: string
  predicate: string
  objectEntityId?: string
  objectText?: string
  confidence: number
  status: KnowledgeStatementStatus
  source: KnowledgeStatementSource
  evidenceIds: string[]
  conflictGroup?: string
  supersededById?: string
  /** Present while every supporting evidence belongs to a superseded revision. */
  notCurrent?: KnowledgeNotCurrentMark
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface KnowledgeRelation {
  id: string
  workspaceId: string
  worldId: string
  fromEntityId: string
  toEntityId: string
  predicate: string
  confidence: number
  status: KnowledgeStatementStatus
  source: KnowledgeStatementSource
  evidenceIds: string[]
  conflictGroup?: string
  supersededById?: string
  /** Present while every supporting evidence belongs to a superseded revision. */
  notCurrent?: KnowledgeNotCurrentMark
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type KnowledgeEvidenceSourceType = 'conversation' | 'document' | 'artifact' | 'manual'

export interface KnowledgeEvidenceBase {
  id: string
  workspaceId: string
  worldId: string
  sourceType: KnowledgeEvidenceSourceType
  excerpt: string
  sourceWeight: number
  createdAt: IsoTimestamp
}

export interface KnowledgeConversationEvidence extends KnowledgeEvidenceBase {
  sourceType: 'conversation'
  sessionId: string
  messageId: string
  sequence: number
}

export interface KnowledgeDocumentEvidence extends KnowledgeEvidenceBase {
  sourceType: 'document'
  documentId: string
  chunkId: string
}

export interface KnowledgeArtifactEvidence extends KnowledgeEvidenceBase {
  sourceType: 'artifact'
  artifactId: string
  artifactVersion?: number
}

export interface KnowledgeManualEvidence extends KnowledgeEvidenceBase {
  sourceType: 'manual'
  createdBy: 'owner'
  note?: string
}

export type KnowledgeEvidence =
  | KnowledgeConversationEvidence
  | KnowledgeDocumentEvidence
  | KnowledgeArtifactEvidence
  | KnowledgeManualEvidence

type KnowledgeEvidenceInputBase = {
  id?: string
  createdAt?: IsoTimestamp
}

export type KnowledgeEvidenceInput =
  | (Omit<KnowledgeConversationEvidence, 'id' | 'createdAt' | 'sourceWeight'> & KnowledgeEvidenceInputBase)
  | (Omit<KnowledgeDocumentEvidence, 'id' | 'createdAt' | 'sourceWeight'> & KnowledgeEvidenceInputBase)
  | (Omit<KnowledgeArtifactEvidence, 'id' | 'createdAt' | 'sourceWeight'> & KnowledgeEvidenceInputBase)
  | (Omit<KnowledgeManualEvidence, 'id' | 'createdAt' | 'sourceWeight'> & KnowledgeEvidenceInputBase)

export interface KnowledgeEntityInput {
  id?: string
  workspaceId: string
  worldId: string
  type: KnowledgeEntityType
  canonicalName: string
  aliases?: string[]
  summary?: string
  status?: KnowledgeEntityStatus
  createdAt?: IsoTimestamp
}

export interface KnowledgeClaimInput {
  id?: string
  workspaceId: string
  worldId: string
  type: KnowledgeClaimType
  subjectEntityId: string
  predicate: string
  objectEntityId?: string
  objectText?: string
  confidence?: number
  status?: KnowledgeStatementStatus
  source?: KnowledgeStatementSource
  evidenceIds?: string[]
  conflictGroup?: string
  supersededById?: string
  createdAt?: IsoTimestamp
}

export interface KnowledgeRelationInput {
  id?: string
  workspaceId: string
  worldId: string
  fromEntityId: string
  toEntityId: string
  predicate: string
  confidence?: number
  status?: KnowledgeStatementStatus
  source?: KnowledgeStatementSource
  evidenceIds?: string[]
  conflictGroup?: string
  supersededById?: string
  createdAt?: IsoTimestamp
}

export interface KnowledgeGraphQuery {
  focusEntityId?: string
  depth?: 1 | 2
  entityType?: KnowledgeEntityType
  sourceType?: KnowledgeEvidenceSourceType | 'all'
  includeArchived?: boolean
  limit?: number
}

export interface KnowledgeGraphSnapshot {
  worldId: string
  entities: KnowledgeEntity[]
  claims: KnowledgeClaim[]
  relations: KnowledgeRelation[]
  evidence: KnowledgeEvidence[]
  generatedAt: IsoTimestamp
}

export interface KnowledgeConversationCursor {
  workspaceId: string
  worldId: string
  sessionId: string
  processedThroughSequence: number
  updatedAt: IsoTimestamp
}

export type KnowledgeConsolidationSourceType = 'conversation' | 'document' | 'artifact'
export type KnowledgeConsolidationJobStatus = 'queued' | 'running' | 'completed' | 'failed'

/** Chunked sources are walked window by window; a conversation is not. */
export type KnowledgeChunkedSourceType = 'document' | 'artifact'

/**
 * One identifiable revision of a chunked knowledge source, plus how far
 * extraction has actually got through it.
 *
 * `contentHash` is the version identity — a document's sha256, an artifact's
 * version — so changed content becomes a *new* version instead of silently
 * overwriting the previous one. `processedChunks` is the resume cursor and the
 * completion watermark at once: a version is finished only when it equals
 * `chunkTotal`, which is the single fact any "已整理" status may be derived
 * from. A failure leaves it exactly where it was, so the next attempt restarts
 * at the chunk that failed and never past it.
 *
 * `supersededAt` / `supersededByHash` mark a version whose content has since
 * changed — a rewritten document, a new artifact version, or a source that was
 * deleted or archived, which is superseded with no replacement hash. Marking
 * deletes nothing: the claims extracted from that content stay exactly where
 * they are, and `invalidatedAt` records that the downgrade pass has since read
 * this row and decided which of them lost their last live evidence.
 */
export interface KnowledgeSourceVersion {
  workspaceId: string
  worldId: string
  sourceType: KnowledgeChunkedSourceType
  sourceId: string
  contentHash: string
  chunkTotal: number
  processedChunks: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  completedAt?: IsoTimestamp
  supersededAt?: IsoTimestamp
  supersededByHash?: string
  /**
   * When the evidence-invalidation pass last processed this superseded
   * version. It is compared against `supersededAt` rather than merely being
   * present, so a version that becomes current again and is later superseded
   * a second time re-enters the work list instead of being skipped forever.
   */
  invalidatedAt?: IsoTimestamp
}

/** What one run of the downgrade pass did to a single superseded version. */
export interface KnowledgeEvidenceInvalidationResult {
  version: KnowledgeSourceVersion
  /** Claims that lost their last live evidence and became not-current. */
  claims: number
  relations: number
}

export interface KnowledgeConsolidationJob {
  id: string
  workspaceId: string
  worldId: string
  sourceType: KnowledgeConsolidationSourceType
  sourceId: string
  fromCursor: number
  toCursor: number
  status: KnowledgeConsolidationJobStatus
  attempt: number
  errorCode?: string
  /**
   * Watermark of the job's source version, not of this one window. A reader
   * must never conclude from `status: 'completed'` alone that the whole source
   * has been processed; these two say how much of it actually has. Absent for
   * conversation sources, which carry a sequence cursor instead.
   */
  processedChunks?: number
  chunkTotal?: number
  /**
   * How many of this source's claims are waiting to be re-verified because the
   * revision they came from is gone. Projected from the graph, not stored on
   * the job: a finished job plus a positive count is the honest reading of a
   * source whose content has moved on since it was extracted.
   */
  notCurrentClaims?: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  startedAt?: IsoTimestamp
  completedAt?: IsoTimestamp
}

export type KnowledgeAutoConsolidationMode = 'off' | 'balanced'

export interface WorldKnowledgeSettings {
  workspaceId: string
  worldId: string
  retrievalEnabled: boolean
  autoConsolidationMode: KnowledgeAutoConsolidationMode
  extractionModelProfileId?: string
  updatedAt: IsoTimestamp
}

export type KnowledgeSuppressionTarget = 'entity' | 'claim' | 'relation'

export interface KnowledgeSuppression {
  id: string
  workspaceId: string
  worldId: string
  targetType: KnowledgeSuppressionTarget
  fingerprint: string
  evidenceIds: string[]
  createdAt: IsoTimestamp
}

/** Model boundary for semantic extraction; implementations must return strict JSON. */
export interface KnowledgeExtractionContext {
  workspaceId: string
  worldId: string
  sourceType: KnowledgeConsolidationSourceType | 'manual'
  sourceId: string
  evidenceIds: string[]
  content: string
  sessionId?: string
  workTurnId?: string
  characterId?: string
}

export interface KnowledgeExtractionResult {
  entities: Array<{
    type: KnowledgeEntityType
    canonicalName: string
    aliases?: string[]
    summary?: string
  }>
  claims: Array<{
    type: KnowledgeClaimType
    subject: string
    predicate: string
    object?: string
    confidence: number
    evidenceRefs: string[]
  }>
  relations: Array<{
    from: string
    to: string
    predicate: string
    confidence: number
    evidenceRefs: string[]
  }>
}

export interface KnowledgeExtractionPort {
  extract(context: KnowledgeExtractionContext): Promise<KnowledgeExtractionResult>
}

/** Non-sensitive summary for knowledge model interaction telemetry. */
export interface KnowledgeExtractionTelemetry {
  modelId: string
  durationMs: number
  promptCharCount: number
  responseCharCount: number
  tokensPrompt?: number
  tokensCompletion?: number
  tokensTotal?: number
  errorCode?: string
}

export function isKnowledgeEntityType(value: string): value is KnowledgeEntityType {
  return [
    'character', 'person', 'place', 'organization', 'project', 'artifact', 'technology',
    'concept', 'tool', 'process', 'event', 'topic', 'object', 'other',
  ].includes(value as KnowledgeEntityType)
}

export function isKnowledgeClaimType(value: string): value is KnowledgeClaimType {
  return ['fact', 'decision', 'preference', 'rule', 'definition', 'procedure', 'constraint', 'insight', 'lore']
    .includes(value as KnowledgeClaimType)
}

export function isKnowledgeEvidenceSourceType(value: string): value is KnowledgeEvidenceSourceType {
  return ['conversation', 'document', 'artifact', 'manual'].includes(value as KnowledgeEvidenceSourceType)
}

export function isKnowledgeJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
