import type {
  KnowledgeClaimType,
  KnowledgeEntityType,
  KnowledgeEvidenceSourceType,
} from './world-knowledge-graph-service.js'
import {
  KNOWLEDGE_CLAIM_TYPES,
  KNOWLEDGE_ENTITY_TYPES,
} from './world-knowledge-graph-service.js'

export const KNOWLEDGE_EXTRACTION_LIMITS = {
  maxInputChars: 16_000,
  maxOutputChars: 64_000,
  maxEntities: 100,
  maxClaims: 200,
  maxRelations: 200,
  maxEvidenceRefs: 400,
  maxNameChars: 180,
  maxSummaryChars: 800,
  maxPredicateChars: 160,
  maxObjectChars: 800,
  maxExcerptChars: 1_200,
} as const

export interface KnowledgeExtractionEvidenceRef {
  sourceType: KnowledgeEvidenceSourceType
  sourceId: string
  evidenceId: string
}

export interface KnowledgeExtractionEntity {
  key: string
  type: KnowledgeEntityType
  canonicalName: string
  aliases: string[]
  summary?: string
  evidenceRefs: string[]
}

export interface KnowledgeExtractionClaim {
  key: string
  type: KnowledgeClaimType
  subjectKey: string
  predicate: string
  objectKey?: string
  objectText?: string
  confidence: number
  evidenceRefs: string[]
}

export interface KnowledgeExtractionRelation {
  key: string
  fromKey: string
  toKey: string
  predicate: string
  confidence: number
  evidenceRefs: string[]
}

export interface KnowledgeExtraction {
  entities: KnowledgeExtractionEntity[]
  claims: KnowledgeExtractionClaim[]
  relations: KnowledgeExtractionRelation[]
  evidenceRefs: KnowledgeExtractionEvidenceRef[]
}

export interface KnowledgeExtractionEvidence {
  evidenceId: string
  sourceType: KnowledgeEvidenceSourceType
  sourceId: string
  excerpt: string
  worldId: string
  workspaceId: string
  sessionId?: string
  messageId?: string
  sequence?: number
  documentId?: string
  chunkId?: string
  artifactId?: string
  artifactVersion?: string
  createdBy?: 'owner' | 'system'
}

export interface KnowledgeExtractionRequest {
  workspaceId: string
  worldId: string
  sourceType: KnowledgeEvidenceSourceType
  sourceId: string
  modelProfileId?: string
  inputChars: number
  evidence: readonly KnowledgeExtractionEvidence[]
  /** Only visible, source-authored text belongs in this batch. */
  visibleText: string
  /** Set by the consolidation service on its one corrective retry. */
  attemptHint?: boolean
}

export interface KnowledgeExtractionUsage {
  model?: string
  inputTokens?: number
  outputTokens?: number
}

export interface KnowledgeExtractionPortResult {
  payload: unknown
  usage?: KnowledgeExtractionUsage
}

/**
 * Provider-neutral. A production implementation may call an OpenAI-compatible
 * or Anthropic-compatible HTTP model directly through ModelProfile and the
 * encrypted credential service. It must not construct an Employee, WorkTurn,
 * AgentRun, or DSH worker for extraction.
 */
export interface KnowledgeExtractionPort {
  extract(input: KnowledgeExtractionRequest): Promise<unknown | KnowledgeExtractionPortResult>
}

export interface KnowledgeModelInteraction {
  workspaceId: string
  worldId: string
  modelProfileId?: string
  model?: string
  durationMs: number
  inputChars: number
  outputChars: number
  inputTokens?: number
  outputTokens?: number
  errorCode?: string
}

export class KnowledgeExtractionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KnowledgeExtractionError'
    this.code = code
  }
}

export function parseKnowledgeExtraction(
  value: unknown,
  context: {
    sourceType: KnowledgeEvidenceSourceType
    sourceId: string
    evidence: readonly KnowledgeExtractionEvidence[]
  },
): KnowledgeExtraction {
  const payload = typeof value === 'string' ? parseJson(value) : value
  const root = strictRecord(payload, '根对象')
  // Explicit root contract. A response that declares no evidenceRefs is not a
  // legitimate empty result but an unusable answer: without this check, `{}`
  // would parse as zero facts and the job would complete as a false success.
  // Omitting entities/claims/relations when a category is genuinely empty is
  // still tolerated.
  if (!('evidenceRefs' in root)) throw invalid('extraction_field_required', '抽取结果缺少 evidenceRefs')
  const allowedEvidence = new Map<string, KnowledgeExtractionEvidenceRef>()
  for (const evidence of context.evidence) {
    if (evidence.worldId.trim() === '' || evidence.workspaceId.trim() === '') throw invalid('evidence_scope_invalid', '证据缺少世界或工作区边界')
    if (evidence.sourceType !== context.sourceType || evidence.sourceId !== context.sourceId) {
      throw invalid('evidence_source_mismatch', '抽取结果引用了当前批次之外的证据')
    }
    if (allowedEvidence.has(evidence.evidenceId)) throw invalid('evidence_id_duplicate', '证据编号重复')
    allowedEvidence.set(evidence.evidenceId, {
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      evidenceId: evidence.evidenceId,
    })
  }
  const evidenceRefs = parseEvidenceRefs(root.evidenceRefs ?? [], context, allowedEvidence)
  const entities = parseEntities(root.entities ?? [], evidenceRefs)
  const entityKeys = new Set(entities.map((item) => item.key))
  const claims = parseClaims(root.claims ?? [], entityKeys, evidenceRefs)
  const relations = parseRelations(root.relations ?? [], entityKeys, evidenceRefs)
  return { entities, claims, relations, evidenceRefs }
}

function parseEvidenceRefs(value: unknown, context: { sourceType: KnowledgeEvidenceSourceType; sourceId: string }, allowed: Map<string, KnowledgeExtractionEvidenceRef>): KnowledgeExtractionEvidenceRef[] {
  const items = strictArray(value, 'evidenceRefs', KNOWLEDGE_EXTRACTION_LIMITS.maxEvidenceRefs)
  const seen = new Set<string>()
  return items.map((item) => {
    const record = strictRecord(item, '证据引用')
    exactKeys(record, ['sourceType', 'sourceId', 'evidenceId'], '证据引用')
    const sourceType = enumValue(record.sourceType, ['conversation', 'document', 'artifact', 'manual'] as const, 'sourceType')
    const sourceId = text(record.sourceId, 'sourceId', 180)
    const evidenceId = text(record.evidenceId, 'evidenceId', 180)
    if (sourceType !== context.sourceType || sourceId !== context.sourceId || !allowed.has(evidenceId)) throw invalid('evidence_source_mismatch', '证据引用不属于当前批次')
    if (seen.has(evidenceId)) throw invalid('evidence_id_duplicate', '证据引用重复')
    seen.add(evidenceId)
    return { sourceType, sourceId, evidenceId }
  })
}

function parseEntities(value: unknown, refs: readonly KnowledgeExtractionEvidenceRef[]): KnowledgeExtractionEntity[] {
  const items = strictArray(value ?? [], 'entities', KNOWLEDGE_EXTRACTION_LIMITS.maxEntities)
  const output = items.map((item) => {
    const record = strictRecord(item, '实体')
    const keyShape = 'key' in record
    exactKeys(record, keyShape ? ['key', 'type', 'canonicalName', 'aliases', 'evidenceRefs'] : ['type', 'canonicalName', 'aliases', 'evidenceRefs'], '实体', ['summary'])
    const summary = optionalText(record.summary, KNOWLEDGE_EXTRACTION_LIMITS.maxSummaryChars)
    return {
      key: text(keyShape ? record.key : record.canonicalName, keyShape ? 'key' : 'canonicalName', 120),
      // Entities anchor the graph, so an invented type degrades into the
      // vocabulary's honest catch-all ('other'). Anything else (missing field,
      // unprovable evidence) must still fail visibly, never be silently eaten.
      type: tolerantEnum(record.type, KNOWLEDGE_ENTITY_TYPES) ?? 'other',
      canonicalName: text(record.canonicalName, 'canonicalName', KNOWLEDGE_EXTRACTION_LIMITS.maxNameChars),
      aliases: stringArray(record.aliases, 'aliases', 12, KNOWLEDGE_EXTRACTION_LIMITS.maxNameChars),
      ...(summary === undefined ? {} : { summary }),
      evidenceRefs: refKeys(record.evidenceRefs, refs),
    }
  })
  unique(output.map((item) => item.key), '实体 key')
  return output
}

function parseClaims(value: unknown, entityKeys: Set<string>, refs: readonly KnowledgeExtractionEvidenceRef[]): KnowledgeExtractionClaim[] {
  const items = strictArray(value ?? [], 'claims', KNOWLEDGE_EXTRACTION_LIMITS.maxClaims)
  const output = items.flatMap((item) => {
    try {
      return [buildClaim(item, entityKeys, refs)]
    } catch (error) {
      // Only the designed skip (unknown status / dangling subject) drops the
      // item; provenance or shape problems still fail the batch visibly.
      if (error instanceof KnowledgeExtractionError && error.code === 'extraction_dropped_item') return []
      throw error
    }
  })
  unique(output.map((entry) => entry.key), '主张 key')
  return output
}

function buildClaim(item: unknown, entityKeys: Set<string>, refs: readonly KnowledgeExtractionEvidenceRef[]): KnowledgeExtractionClaim {
    const record = strictRecord(item, '主张')
    const keyShape = 'subjectKey' in record
    exactKeys(record, keyShape ? ['key', 'type', 'subjectKey', 'predicate', 'confidence', 'evidenceRefs'] : ['type', 'subject', 'predicate', 'confidence', 'evidenceRefs'], '主张', keyShape ? ['objectKey', 'objectText'] : ['object'])
    const subjectKey = text(keyShape ? record.subjectKey : record.subject, keyShape ? 'subjectKey' : 'subject', 120)
    // Claim status has no honest catch-all bucket, so an invented type drops
    // this one claim instead of discarding the whole batch.
    const type = tolerantEnum(record.type, KNOWLEDGE_CLAIM_TYPES)
    if (type === undefined || !entityKeys.has(subjectKey)) throw invalid('extraction_dropped_item', '该主张的 type 越界或 subjectKey 无对应实体')
    const rawObjectKey = keyShape
      ? optionalText(record.objectKey, 120)
      : optionalText(record.object, KNOWLEDGE_EXTRACTION_LIMITS.maxObjectChars)
    let objectText = keyShape ? optionalText(record.objectText, KNOWLEDGE_EXTRACTION_LIMITS.maxObjectChars) : (rawObjectKey !== undefined && entityKeys.has(rawObjectKey) ? undefined : rawObjectKey)
    let resolvedObjectKey = keyShape ? rawObjectKey : (rawObjectKey !== undefined && entityKeys.has(rawObjectKey) ? rawObjectKey : undefined)
    if (keyShape && resolvedObjectKey !== undefined) {
      // Provider tolerance: a claim that carries both shapes keeps the entity
      // pointer, and an objectKey that resolves to no entity is demoted to
      // object text instead of failing the whole batch. The old behaviour
      // threw, so one hallucinated key discarded every valid fact.
      if (entityKeys.has(resolvedObjectKey)) {
        objectText = undefined
      } else {
        objectText = objectText ?? resolvedObjectKey
        resolvedObjectKey = undefined
      }
    }
    if (resolvedObjectKey === undefined && objectText === undefined) throw invalid('claim_object_required', '主张必须提供 objectKey 或 objectText')
    return {
      key: text(keyShape ? record.key : subjectKey + ':' + text(record.predicate, 'predicate', KNOWLEDGE_EXTRACTION_LIMITS.maxPredicateChars), 'key', 120),
      type,
      subjectKey,
      predicate: text(record.predicate, 'predicate', KNOWLEDGE_EXTRACTION_LIMITS.maxPredicateChars),
      ...(resolvedObjectKey === undefined ? {} : { objectKey: resolvedObjectKey }),
      ...(objectText === undefined ? {} : { objectText }),
      confidence: confidence(record.confidence),
      evidenceRefs: refKeys(record.evidenceRefs, refs),
    }
}

function parseRelations(value: unknown, entityKeys: Set<string>, refs: readonly KnowledgeExtractionEvidenceRef[]): KnowledgeExtractionRelation[] {
  const items = strictArray(value ?? [], 'relations', KNOWLEDGE_EXTRACTION_LIMITS.maxRelations)
  const output = items.flatMap((item) => {
    const record = strictRecord(item, '关系')
    const keyShape = 'fromKey' in record
    exactKeys(record, keyShape ? ['key', 'fromKey', 'toKey', 'predicate', 'confidence', 'evidenceRefs'] : ['from', 'to', 'predicate', 'confidence', 'evidenceRefs'], '关系')
    const fromKey = text(keyShape ? record.fromKey : record.from, keyShape ? 'fromKey' : 'from', 120)
    const toKey = text(keyShape ? record.toKey : record.to, keyShape ? 'toKey' : 'to', 120)
    // The only designed skip: an edge across entities the batch never
    // declared. Shape, confidence and evidence problems still fail the batch
    // visibly, so a malformed relation cannot hide as a completed job.
    if (!entityKeys.has(fromKey) || !entityKeys.has(toKey)) return []
    return [{
      key: text(keyShape ? record.key : fromKey + ':' + text(record.predicate, 'predicate', KNOWLEDGE_EXTRACTION_LIMITS.maxPredicateChars) + ':' + toKey, 'key', 120),
      fromKey,
      toKey,
      predicate: text(record.predicate, 'predicate', KNOWLEDGE_EXTRACTION_LIMITS.maxPredicateChars),
      confidence: confidence(record.confidence),
      evidenceRefs: refKeys(record.evidenceRefs, refs),
    }]
  })
  unique(output.map((item) => item.key), '关系 key')
  return output
}

function refKeys(value: unknown, refs: readonly KnowledgeExtractionEvidenceRef[]): string[] {
  if (!Array.isArray(value) || value.length > 32) throw invalid('extraction_array_invalid', 'evidenceRefs必须是字符串数组')
  // Provider tolerance: a model often writes an evidence reference as an object
  // ({"evidenceId": ...} / {"id": ...} / {"key": ...}) instead of the bare id
  // string. Reading the id out is faithful to intent and was silently dropping
  // every item (a 13k-char answer yielding zero rows).
  const output = [...new Set(value.map((item) => {
    if (typeof item === 'string') return text(item, 'evidenceRefs', 180)
    const record = objectOrUndefined(item)
    const id = record?.evidenceId ?? record?.id ?? record?.key
    if (typeof id === 'string') return text(id, 'evidenceRefs', 180)
    throw invalid('extraction_text_invalid', 'evidenceRefs必须是字符串或证据对象')
  }))]
  const known = new Set(refs.map((item) => item.evidenceId))
  if (output.length === 0) throw invalid('evidence_required', '自动知识必须带有证据')
  if (output.some((item) => !known.has(item))) throw invalid('evidence_reference_unknown', '知识引用了未声明的证据')
  return output
}
function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseJson(value: string): unknown {
  if (value.length > KNOWLEDGE_EXTRACTION_LIMITS.maxOutputChars) throw invalid('extraction_output_too_large', '知识抽取结果过大')
  const cleaned = value
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
    .trim()
  // A whole-answer fence was stripped above; models also put a sentence before
  // or after the object. Read the one JSON object out of the answer (same rule
  // as parseJsonObject in model-json-call) before declaring it invalid.
  const candidates = [cleaned]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(cleaned)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1))
  // A compatible gateway that caps completion mid-stream yields truncated JSON.
  // Salvaging every whole member beats discarding the whole batch — and the
  // next job's cursor already stops at the messages actually sent.
  const repaired = start >= 0 ? repairTruncatedJson(cleaned.slice(start)) : undefined
  if (repaired !== undefined) candidates.push(repaired)
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown } catch {
      // Try the next shape.
    }
  }
  throw invalid('extraction_json_invalid', '知识抽取结果不是有效 JSON')
}

/**
 * Close a JSON object the model never finished: keep everything up to the last
 * complete element at ANY depth and close the open containers around it, so a
 * completion capped mid-array still yields the entities and claims it finished.
 * Returns undefined when the answer is too incomplete to salvage.
 */
export function repairTruncatedJson(text: string): string | undefined {
  const stack: string[] = []
  let inString = false
  let escaped = false
  let cutEnd = -1
  let cutClosers = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') { stack.push(char); continue }
    if (char === '}' || char === ']') {
      stack.pop()
      if (stack.length === 0) return undefined // already balanced — not truncated
      // Any closed element is a safe cut: whatever remains open gets mirrored.
      cutEnd = index
      cutClosers = stack.map((open) => (open === '{' ? '}' : ']')).reverse().join('')
    }
  }
  if (stack.length === 0 || cutEnd < 0) return undefined
  const head = text.slice(0, cutEnd + 1).replace(/,\s*$/, '')
  const candidate = `${head}${cutClosers}`
  try { JSON.parse(candidate) as unknown; return candidate } catch { return undefined }
}
function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('extraction_shape_invalid', label + '必须是对象')
  return value as Record<string, unknown>
}
function strictArray(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid('extraction_array_invalid', label + '必须是有限数组')
  return value
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, optional: readonly string[] = []): void {
  // Provider tolerance: unexpected extra fields are ignored rather than fatal.
  // The field readers below take what they need; one invented "notes" key used
  // to throw away an otherwise-valid batch. Required fields still fail fast.
  void optional
  for (const key of keys) if (!(key in value)) throw invalid('extraction_field_required', label + '缺少字段：' + key)
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw invalid('extraction_text_invalid', label + '必须是字符串')
  const normalized = value.trim()
  if (!normalized || Array.from(normalized).length > max) throw invalid('extraction_text_invalid', label + '为空或过长')
  return normalized
}
function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return text(value, '文本', max)
}
function stringArray(value: unknown, label: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalid('extraction_array_invalid', label + '必须是字符串数组')
  return [...new Set(value.map((item) => text(item, label, maxChars)))]
}
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalid('extraction_enum_invalid', label + '不受支持')
  return value as T
}
function tolerantEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined
}
function confidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw invalid('confidence_invalid', '置信度必须在 0 到 1 之间')
  return value
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw invalid('extraction_key_duplicate', label + '重复')
}
function invalid(code: string, message: string): KnowledgeExtractionError { return new KnowledgeExtractionError(code, message) }
