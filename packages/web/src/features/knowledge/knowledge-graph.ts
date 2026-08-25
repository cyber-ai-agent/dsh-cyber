export type KnowledgeGraphEntityType =
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

export type KnowledgeGraphSourceKind = 'conversation' | 'document' | 'artifact' | 'manual'
export type KnowledgeGraphClaimType = 'fact' | 'decision' | 'preference' | 'rule' | 'definition' | 'procedure' | 'constraint' | 'insight' | 'lore'
export type KnowledgeGraphStatementStatus = 'active' | 'conflicted' | 'superseded' | 'archived'
export type KnowledgeGraphStatementSource = 'auto' | 'manual'

export interface KnowledgeGraphClaim {
  id: string
  type: KnowledgeGraphClaimType
  subjectEntityId: string
  predicate: string
  objectEntityId?: string
  objectText?: string
  confidence: number
  status: KnowledgeGraphStatementStatus
  source: KnowledgeGraphStatementSource
  evidenceIds: string[]
}

export interface KnowledgeGraphRelation {
  id: string
  fromEntityId: string
  toEntityId: string
  predicate: string
  confidence: number
  status: KnowledgeGraphStatementStatus
  source: KnowledgeGraphStatementSource
  evidenceIds: string[]
}

export interface KnowledgeGraphEvidence {
  id: string
  sourceType: KnowledgeGraphSourceKind
  excerpt: string
  sourceWeight: number
  documentId?: string
  chunkId?: string
  sessionId?: string
  messageId?: string
  sequence?: number
  artifactId?: string
  artifactVersion?: number
  note?: string
}

export interface KnowledgeGraphNodeRelation {
  id: string
  targetId: string
  label: string
  confidence: number
  status: KnowledgeGraphStatementStatus
  evidenceIds: string[]
}

export interface KnowledgeGraphNode {
  id: string
  name: string
  type: KnowledgeGraphEntityType
  source: KnowledgeGraphSourceKind
  sourceLabel: string
  summary: string
  claims: KnowledgeGraphClaim[]
  relations: KnowledgeGraphNodeRelation[]
  evidence: KnowledgeGraphEvidence[]
}

export interface KnowledgeGraphEdge {
  id: string
  sourceId: string
  targetId: string
  label: string
  confidence: number
  status: KnowledgeGraphStatementStatus
  evidenceIds: string[]
}

export interface KnowledgeGraphSnapshot {
  worldId: string
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  claims: KnowledgeGraphClaim[]
  relations: KnowledgeGraphRelation[]
  evidence: KnowledgeGraphEvidence[]
  generatedAt?: string
  truncated?: boolean
}

export interface KnowledgeGraphPosition {
  x: number
  y: number
}

export interface KnowledgeGraphFilters {
  query: string
  entityType: KnowledgeGraphEntityType | 'all'
  source: KnowledgeGraphSourceKind | 'all'
  depth: 0 | 1 | 2
}

export const KNOWLEDGE_GRAPH_LIMIT = 300

export const KNOWLEDGE_GRAPH_ENTITY_TYPES: readonly KnowledgeGraphEntityType[] = [
  'character', 'person', 'place', 'organization', 'project', 'artifact', 'technology', 'concept', 'tool', 'process', 'event', 'topic', 'object', 'other',
]

export const KNOWLEDGE_GRAPH_SOURCES: readonly KnowledgeGraphSourceKind[] = ['conversation', 'document', 'artifact', 'manual']

export const KNOWLEDGE_GRAPH_ENTITY_LABELS: Record<KnowledgeGraphEntityType, string> = {
  character: '角色',
  person: '人物',
  place: '地点',
  organization: '组织',
  project: '项目',
  artifact: '产物',
  technology: '技术',
  concept: '概念',
  tool: '工具',
  process: '流程',
  event: '事件',
  topic: '主题',
  object: '对象',
  other: '其他',
}

export const KNOWLEDGE_GRAPH_SOURCE_LABELS: Record<KnowledgeGraphSourceKind, string> = {
  conversation: '对话',
  document: '资料',
  artifact: '产物',
  manual: '手动整理',
}

export const KNOWLEDGE_GRAPH_CLAIM_STATUS_LABELS: Record<KnowledgeGraphStatementStatus, string> = {
  active: '当前主张',
  conflicted: '存在冲突',
  superseded: '已被替代',
  archived: '已归档',
}

const ENTITY_TYPES = new Set<KnowledgeGraphEntityType>(KNOWLEDGE_GRAPH_ENTITY_TYPES)
const SOURCE_KINDS = new Set<KnowledgeGraphSourceKind>(KNOWLEDGE_GRAPH_SOURCES)
const CLAIM_TYPES = new Set<KnowledgeGraphClaimType>(['fact', 'decision', 'preference', 'rule', 'definition', 'procedure', 'constraint', 'insight', 'lore'])
const STATUSES = new Set<KnowledgeGraphStatementStatus>(['active', 'conflicted', 'superseded', 'archived'])
const STATEMENT_SOURCES = new Set<KnowledgeGraphStatementSource>(['auto', 'manual'])

export function knowledgeGraphPath(worldId: string, limit = KNOWLEDGE_GRAPH_LIMIT): string {
  const params = new URLSearchParams({ limit: String(limit) })
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/graph?${params.toString()}`
}

export function normalizeKnowledgeGraph(value: unknown, worldId: string): KnowledgeGraphSnapshot {
  const root = isRecord(value) && isRecord(value.graph) ? value.graph : value
  if (!isRecord(root)) return emptySnapshot(worldId)
  const entities = Array.isArray(root.entities) ? root.entities : []
  const claims = Array.isArray(root.claims) ? root.claims.map(normalizeClaim).filter(isDefined) : []
  const relations = Array.isArray(root.relations) ? root.relations.map(normalizeRelation).filter(isDefined) : []
  const evidence = Array.isArray(root.evidence) ? root.evidence.map(normalizeEvidence).filter(isDefined) : []
  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  const claimsByEntity = indexClaimsByEntity(claims)
  const relationsByEntity = indexRelationsByEntity(relations)
  const nodes = entities.map((entity, index) => normalizeNode(entity, index, claimsByEntity.get(entityId(entity)), relationsByEntity.get(entityId(entity)), evidenceById)).filter(isDefined).slice(0, KNOWLEDGE_GRAPH_LIMIT)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = relations
    .filter((relation) => nodeIds.has(relation.fromEntityId) && nodeIds.has(relation.toEntityId))
    .map((relation) => ({ id: relation.id, sourceId: relation.fromEntityId, targetId: relation.toEntityId, label: relation.predicate, confidence: relation.confidence, status: relation.status, evidenceIds: relation.evidenceIds }))
  return {
    worldId,
    nodes,
    edges,
    claims,
    relations,
    evidence,
    ...(typeof root.generatedAt === 'string' ? { generatedAt: root.generatedAt } : {}),
    ...(root.truncated === true || entities.length > KNOWLEDGE_GRAPH_LIMIT ? { truncated: true } : {}),
  }
}

export function layoutKnowledgeGraph(nodes: readonly KnowledgeGraphNode[]): Map<string, KnowledgeGraphPosition> {
  const positions = new Map<string, KnowledgeGraphPosition>()
  if (nodes.length === 0) return positions
  const columns = Math.max(4, Math.ceil(Math.sqrt(nodes.length * 1.45)))
  const horizontalGap = 176
  const verticalGap = 126
  const offsetX = ((columns - 1) * horizontalGap) / 2
  const rows = Math.ceil(nodes.length / columns)
  const offsetY = ((rows - 1) * verticalGap) / 2
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node === undefined) continue
    const column = index % columns
    const row = Math.floor(index / columns)
    positions.set(node.id, {
      x: column * horizontalGap - offsetX + (stableHash(node.id) % 3) * 8,
      y: row * verticalGap - offsetY + (stableHash(`${node.id}:row`) % 3) * 6,
    })
  }
  return positions
}

export function filterKnowledgeGraph(snapshot: KnowledgeGraphSnapshot, filters: KnowledgeGraphFilters, selectedId?: string): { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; matchedIds: Set<string> } {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase()
  const matchedIds = new Set<string>()
  for (const node of snapshot.nodes) {
    const claimText = node.claims.map((claim) => `${claim.predicate} ${claim.objectText ?? ''}`).join(' ')
    const matchesQuery = normalizedQuery.length === 0 || `${node.name} ${node.summary} ${claimText}`.toLocaleLowerCase().includes(normalizedQuery)
    const matchesType = filters.entityType === 'all' || node.type === filters.entityType
    const matchesSource = filters.source === 'all' || node.source === filters.source
    if (matchesQuery && matchesType && matchesSource) matchedIds.add(node.id)
  }
  const visibleIds = new Set(matchedIds)
  if (selectedId !== undefined && snapshot.nodes.some((node) => node.id === selectedId) && filters.depth > 0) {
    visibleIds.clear()
    visibleIds.add(selectedId)
    const adjacency = buildAdjacency(snapshot.edges)
    let frontier = new Set([selectedId])
    for (let depth = 0; depth < filters.depth; depth += 1) {
      const next = new Set<string>()
      for (const nodeId of frontier) for (const neighbor of adjacency.get(nodeId) ?? []) { visibleIds.add(neighbor); next.add(neighbor) }
      frontier = next
    }
    if (normalizedQuery.length > 0 || filters.entityType !== 'all' || filters.source !== 'all') for (const nodeId of [...visibleIds]) if (nodeId !== selectedId && !matchedIds.has(nodeId)) visibleIds.delete(nodeId)
  }
  const nodes = snapshot.nodes.filter((node) => visibleIds.has(node.id))
  const edges = snapshot.edges.filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
  return { nodes, edges, matchedIds }
}

function normalizeNode(value: unknown, index: number, claims: KnowledgeGraphClaim[] | undefined, relations: KnowledgeGraphRelation[] | undefined, evidenceById: Map<string, KnowledgeGraphEvidence>): KnowledgeGraphNode | undefined {
  if (!isRecord(value)) return undefined
  const id = firstString(value.id, value.entityId, value.entity_id)
  if (id === undefined) return undefined
  const type = normalizeEntityType(firstString(value.type, value.entityType, value.entity_type))
  const nodeClaims = claims ?? []
  const nodeRelations = relations ?? []
  const evidenceIds = new Set([...nodeClaims.flatMap((claim) => claim.evidenceIds), ...nodeRelations.flatMap((relation) => relation.evidenceIds)])
  const evidence = [...evidenceIds].map((evidenceId) => evidenceById.get(evidenceId)).filter(isDefined)
  const source = evidence[0]?.sourceType ?? 'manual'
  return {
    id,
    name: firstString(value.canonicalName, value.name, value.label, value.title) ?? `未命名实体 ${index + 1}`,
    type,
    source,
    sourceLabel: KNOWLEDGE_GRAPH_SOURCE_LABELS[source],
    summary: firstString(value.summary, value.description, value.abstract) ?? '暂无实体摘要。',
    claims: nodeClaims,
    relations: nodeRelations.map((relation) => ({ id: relation.id, targetId: relation.fromEntityId === id ? relation.toEntityId : relation.fromEntityId, label: relation.predicate, confidence: relation.confidence, status: relation.status, evidenceIds: relation.evidenceIds })),
    evidence,
  }
}

function normalizeClaim(value: unknown): KnowledgeGraphClaim | undefined {
  if (!isRecord(value)) return undefined
  const subjectEntityId = firstString(value.subjectEntityId, value.subject_entity_id)
  const id = firstString(value.id)
  if (id === undefined || subjectEntityId === undefined) return undefined
  const typeValue = firstString(value.type)
  const statusValue = firstString(value.status)
  const sourceValue = firstString(value.source)
  const objectEntityId = firstString(value.objectEntityId, value.object_entity_id)
  const objectText = firstString(value.objectText, value.object_text)
  return {
    id,
    type: typeValue !== undefined && CLAIM_TYPES.has(typeValue as KnowledgeGraphClaimType) ? typeValue as KnowledgeGraphClaimType : 'fact',
    subjectEntityId,
    predicate: firstString(value.predicate) ?? '相关事实',
    ...(objectEntityId === undefined ? {} : { objectEntityId }),
    ...(objectText === undefined ? {} : { objectText }),
    confidence: clampNumber(value.confidence, 0),
    status: statusValue !== undefined && STATUSES.has(statusValue as KnowledgeGraphStatementStatus) ? statusValue as KnowledgeGraphStatementStatus : 'active',
    source: sourceValue !== undefined && STATEMENT_SOURCES.has(sourceValue as KnowledgeGraphStatementSource) ? sourceValue as KnowledgeGraphStatementSource : 'auto',
    evidenceIds: normalizeStringArray(value.evidenceIds ?? value.evidence_ids),
  }
}

function normalizeRelation(value: unknown): KnowledgeGraphRelation | undefined {
  if (!isRecord(value)) return undefined
  const id = firstString(value.id)
  const fromEntityId = firstString(value.fromEntityId, value.from_entity_id, value.sourceId, value.source_id)
  const toEntityId = firstString(value.toEntityId, value.to_entity_id, value.targetId, value.target_id)
  if (id === undefined || fromEntityId === undefined || toEntityId === undefined) return undefined
  const statusValue = firstString(value.status)
  const sourceValue = firstString(value.source)
  return {
    id,
    fromEntityId,
    toEntityId,
    predicate: firstString(value.predicate, value.label, value.type) ?? '相关',
    confidence: clampNumber(value.confidence, 0),
    status: statusValue !== undefined && STATUSES.has(statusValue as KnowledgeGraphStatementStatus) ? statusValue as KnowledgeGraphStatementStatus : 'active',
    source: sourceValue !== undefined && STATEMENT_SOURCES.has(sourceValue as KnowledgeGraphStatementSource) ? sourceValue as KnowledgeGraphStatementSource : 'auto',
    evidenceIds: normalizeStringArray(value.evidenceIds ?? value.evidence_ids),
  }
}

function normalizeEvidence(value: unknown): KnowledgeGraphEvidence | undefined {
  if (!isRecord(value)) return undefined
  const id = firstString(value.id)
  const sourceTypeValue = firstString(value.sourceType, value.source_type)
  if (id === undefined || sourceTypeValue === undefined || !SOURCE_KINDS.has(sourceTypeValue as KnowledgeGraphSourceKind)) return undefined
  const documentId = firstString(value.documentId, value.document_id)
  const chunkId = firstString(value.chunkId, value.chunk_id)
  const sessionId = firstString(value.sessionId, value.session_id)
  const messageId = firstString(value.messageId, value.message_id)
  const artifactId = firstString(value.artifactId, value.artifact_id)
  const note = firstString(value.note)
  return {
    id,
    sourceType: sourceTypeValue as KnowledgeGraphSourceKind,
    excerpt: firstString(value.excerpt, value.snippet, value.content) ?? '',
    sourceWeight: clampNumber(value.sourceWeight, 0),
    ...(documentId === undefined ? {} : { documentId }),
    ...(chunkId === undefined ? {} : { chunkId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(typeof value.sequence === 'number' ? { sequence: value.sequence } : {}),
    ...(artifactId === undefined ? {} : { artifactId }),
    ...(typeof value.artifactVersion === 'number' ? { artifactVersion: value.artifactVersion } : {}),
    ...(note === undefined ? {} : { note }),
  }
}

function emptySnapshot(worldId: string): KnowledgeGraphSnapshot {
  return { worldId, nodes: [], edges: [], claims: [], relations: [], evidence: [] }
}

function entityId(value: unknown): string {
  return isRecord(value) && typeof value.id === 'string' ? value.id : ''
}

function indexClaimsByEntity(claims: readonly KnowledgeGraphClaim[]): Map<string, KnowledgeGraphClaim[]> {
  const result = new Map<string, KnowledgeGraphClaim[]>()
  for (const claim of claims) {
    addIndexed(result, claim.subjectEntityId, claim)
    if (claim.objectEntityId !== undefined && claim.objectEntityId !== claim.subjectEntityId) addIndexed(result, claim.objectEntityId, claim)
  }
  return result
}

function indexRelationsByEntity(relations: readonly KnowledgeGraphRelation[]): Map<string, KnowledgeGraphRelation[]> {
  const result = new Map<string, KnowledgeGraphRelation[]>()
  for (const relation of relations) {
    addIndexed(result, relation.fromEntityId, relation)
    if (relation.toEntityId !== relation.fromEntityId) addIndexed(result, relation.toEntityId, relation)
  }
  return result
}

function addIndexed<T extends { id: string }>(index: Map<string, T[]>, key: string, value: T): void {
  const current = index.get(key) ?? []
  current.push(value)
  index.set(key, current)
}

function buildAdjacency(edges: readonly KnowledgeGraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edges) {
    const source = adjacency.get(edge.sourceId) ?? new Set<string>()
    source.add(edge.targetId)
    adjacency.set(edge.sourceId, source)
    const target = adjacency.get(edge.targetId) ?? new Set<string>()
    target.add(edge.sourceId)
    adjacency.set(edge.targetId, target)
  }
  return adjacency
}

function normalizeEntityType(value: string | undefined): KnowledgeGraphEntityType {
  return value !== undefined && ENTITY_TYPES.has(value as KnowledgeGraphEntityType) ? value as KnowledgeGraphEntityType : 'other'
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function clampNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return Math.abs(hash)
}
