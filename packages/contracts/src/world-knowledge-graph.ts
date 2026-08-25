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
