import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  KnowledgeClaim,
  KnowledgeClaimInput,
  KnowledgeConversationEvidence,
  KnowledgeConversationCursor,
  KnowledgeConsolidationJob,
  KnowledgeEntity,
  KnowledgeEntityInput,
  KnowledgeEntityStatus,
  KnowledgeEntityType,
  KnowledgeEvidence,
  KnowledgeEvidenceInput,
  KnowledgeEvidenceSourceType,
  KnowledgeGraphQuery,
  KnowledgeGraphSnapshot,
  KnowledgeRelation,
  KnowledgeRelationInput,
  KnowledgeStatementSource,
  KnowledgeStatementStatus,
  KnowledgeSuppression,
  KnowledgeSuppressionTarget,
  WorldKnowledgeSettings,
} from '@dsh-cyber/contracts'

import { EntityNotFoundError, PersistenceError } from './errors.js'

export interface WorldKnowledgeGraphRepositoryOptions {
  clock?: () => string
  idFactory?: () => string
}

export interface KnowledgeCursorAdvanceInput {
  workspaceId: string
  worldId: string
  sessionId: string
  expectedThroughSequence: number
  processedThroughSequence: number
}

export interface KnowledgeConsolidationJobInput {
  id?: string
  workspaceId: string
  worldId: string
  sourceType: KnowledgeConsolidationJob['sourceType']
  sourceId: string
  fromCursor: number
  toCursor: number
  createdAt?: string
}

export interface KnowledgeGraphListFilter {
  status?: KnowledgeEntityStatus
  type?: KnowledgeEntityType
  query?: string
  includeArchived?: boolean
  limit?: number
  sourceType?: KnowledgeEvidenceSourceType | 'all'
}

export interface KnowledgeStatementListFilter {
  includeArchived?: boolean
  entityId?: string
  entityIds?: readonly string[]
  limit?: number
  sourceType?: KnowledgeEvidenceSourceType | 'all'
}

export interface KnowledgeEvidenceListFilter {
  entityId?: string
  entityIds?: readonly string[]
  claimId?: string
  claimIds?: readonly string[]
  relationId?: string
  relationIds?: readonly string[]
  limit?: number
  sourceType?: KnowledgeEvidenceSourceType | 'all'
}

export interface KnowledgeExtractionEvidenceInput {
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
  artifactVersion?: string | number
  createdBy?: 'owner' | 'system'
}

export interface KnowledgeExtractionPayload {
  entities: Array<{
    key: string
    type: KnowledgeEntityType
    canonicalName: string
    aliases: string[]
    summary?: string
    evidenceRefs: string[]
  }>
  claims: Array<{
    key: string
    type: KnowledgeClaim['type']
    subjectKey: string
    predicate: string
    objectKey?: string
    objectText?: string
    confidence: number
    evidenceRefs: string[]
  }>
  relations: Array<{
    key: string
    fromKey: string
    toKey: string
    predicate: string
    confidence: number
    evidenceRefs: string[]
  }>
  evidenceRefs: Array<{ sourceType: KnowledgeEvidenceSourceType; sourceId: string; evidenceId: string }>
}

type NormalizedEvidenceInput = {
  id?: string
  workspaceId: string
  worldId: string
  sourceType: KnowledgeEvidenceSourceType
  excerpt: string
  createdAt?: string
  sessionId?: string
  messageId?: string
  sequence?: number
  documentId?: string
  chunkId?: string
  artifactId?: string
  artifactVersion?: number
  createdBy?: 'owner'
  note?: string
}

/**
 * Durable authority for the evidence-backed World Knowledge Graph.
 *
 * This repository deliberately does not run extraction or infer facts. It
 * validates provider output and records only world-scoped rows. The service
 * layer owns extraction policy; this class owns atomic persistence and CAS.
 */
export class WorldKnowledgeGraphRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #idFactory: () => string

  constructor(database: DatabaseSync, options: WorldKnowledgeGraphRepositoryOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  getEntity(worldId: string, entityId: string): KnowledgeEntity | undefined
  getEntity(input: { worldId: string; entityId: string }): KnowledgeEntity | undefined
  getEntity(worldOrInput: string | { worldId: string; entityId: string }, entityId?: string): KnowledgeEntity | undefined {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedEntityId = typeof worldOrInput === 'string' ? entityId : worldOrInput.entityId
    if (resolvedEntityId === undefined) throw new PersistenceError('Knowledge entity id is required')
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_entities WHERE world_id = ? AND id = ?',
    ).get(worldId, resolvedEntityId)
    return row === undefined ? undefined : mapEntity(row)
  }

  listEntities(worldId: string, filter?: KnowledgeGraphListFilter): KnowledgeEntity[]
  listEntities(input: { worldId: string; limit: number; entityType?: KnowledgeEntityType; sourceType?: KnowledgeEvidenceSourceType }): KnowledgeEntity[]
  listEntities(worldOrInput: string | { worldId: string; limit: number; entityType?: KnowledgeEntityType; sourceType?: KnowledgeEvidenceSourceType }, filter: KnowledgeGraphListFilter = {}): KnowledgeEntity[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedFilter: KnowledgeGraphListFilter = typeof worldOrInput === 'string'
      ? filter
      : {
        limit: worldOrInput.limit,
        ...(worldOrInput.entityType === undefined ? {} : { type: worldOrInput.entityType }),
        ...(worldOrInput.sourceType === undefined ? {} : { sourceType: worldOrInput.sourceType }),
      }
    assertNonEmpty(worldId, 'World id')
    const clauses = ['world_id = ?']
    const params: Array<string | number> = [worldId]
    if (!resolvedFilter.includeArchived) clauses.push("status <> 'archived'")
    if (resolvedFilter.status !== undefined) {
      assertEntityStatus(resolvedFilter.status)
      clauses.push('status = ?')
      params.push(resolvedFilter.status)
    }
    if (resolvedFilter.type !== undefined) {
      assertEntityType(resolvedFilter.type)
      clauses.push('type = ?')
      params.push(resolvedFilter.type)
    }
    if (resolvedFilter.query?.trim()) {
      const query = `%${escapeLike(resolvedFilter.query.trim())}%`
      clauses.push("(canonical_name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
      params.push(query, query, query)
    }
    const limit = resolvedFilter.limit === undefined ? undefined : clampLimit(resolvedFilter.limit)
    const sourceType = resolvedFilter.sourceType
    const queryLimit = sourceType === undefined || sourceType === 'all' ? limit : undefined
    const suffix = queryLimit === undefined ? '' : ' LIMIT ?'
    if (queryLimit !== undefined) params.push(queryLimit)
    const entities = this.#database.prepare(
      `SELECT * FROM knowledge_entities WHERE ${clauses.join(' AND ')}
       ORDER BY status = 'active' DESC, updated_at DESC, id DESC${suffix}`,
    ).all(...params).map(mapEntity)
    if (sourceType === undefined || sourceType === 'all') return entities
    assertEvidenceSourceType(sourceType)
    return entities.filter((entity) => this.#entityHasEvidenceSource(worldId, entity.id, sourceType)).slice(0, limit)
  }

  searchEntities(worldId: string, query: string, limit: number): KnowledgeEntity[]
  searchEntities(input: { worldId: string; query: string; limit: number }): KnowledgeEntity[]
  searchEntities(worldOrInput: string | { worldId: string; query: string; limit: number }, query?: string, limit?: number): KnowledgeEntity[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedQuery = typeof worldOrInput === 'string' ? query : worldOrInput.query
    const resolvedLimit = typeof worldOrInput === 'string' ? limit : worldOrInput.limit
    assertNonEmpty(worldId, 'World id')
    const normalized = resolvedQuery?.trim() ?? ''
    if (!normalized) return []
    const contains = `%${escapeLike(normalized)}%`
    const prefix = `${escapeLike(normalized)}%`
    return this.#database.prepare(
      `SELECT * FROM knowledge_entities
       WHERE world_id = ? AND status = 'active'
         AND (canonical_name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
       ORDER BY canonical_name = ? COLLATE NOCASE DESC,
                canonical_name LIKE ? ESCAPE '\\' COLLATE NOCASE DESC,
                updated_at DESC, id DESC
       LIMIT ?`,
    ).all(worldId, contains, contains, contains, normalized, prefix, clampLimit(resolvedLimit ?? 20)).map(mapEntity)
  }

  upsertEntity(input: KnowledgeEntityInput): KnowledgeEntity {
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      const normalized = normalizeEntityInput(input)
      const id = normalized.id ?? this.#idFactory()
      this.#assertGlobalOwnership('knowledge_entities', id, world, 'Knowledge entity')
      const existing = this.getEntity(world.id, id)
      if (existing !== undefined && (existing.workspaceId !== world.workspaceId || existing.worldId !== world.id)) {
        throw new PersistenceError('Knowledge entity scope mismatch')
      }
      if (existing === undefined) {
        const now = normalized.createdAt ?? this.#clock()
        this.#database.prepare(
          `INSERT INTO knowledge_entities
           (id, workspace_id, world_id, type, canonical_name, aliases_json, summary, status, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, world.workspaceId, world.id, normalized.type, normalized.canonicalName,
          stringifyJson(normalized.aliases), normalized.summary, normalized.status, now, now,
          normalized.status === 'archived' ? now : null)
      } else {
        const updatedAt = this.#clock()
        this.#database.prepare(
          `UPDATE knowledge_entities
           SET type = ?, canonical_name = ?, aliases_json = ?, summary = ?, status = ?,
               updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE NULL END
           WHERE workspace_id = ? AND world_id = ? AND id = ?`,
        ).run(normalized.type, normalized.canonicalName, stringifyJson(normalized.aliases), normalized.summary,
          normalized.status, updatedAt, normalized.status, updatedAt, world.workspaceId, world.id, id)
      }
      return this.getEntity(world.id, id)!
    })
  }

  renameEntity(worldId: string, entityId: string, canonicalName: string, aliases?: string[]): KnowledgeEntity {
    const entity = this.getEntity(worldId, entityId)
    if (entity === undefined) throw new EntityNotFoundError(`Knowledge entity not found: ${entityId}`)
    const name = canonicalName.trim()
    if (!name) throw new PersistenceError('Knowledge entity name cannot be empty')
    const now = this.#clock()
    this.#database.prepare(
      `UPDATE knowledge_entities SET canonical_name = ?, aliases_json = ?, updated_at = ?
       WHERE world_id = ? AND id = ?`,
    ).run(name, stringifyJson(uniqueStrings(aliases ?? entity.aliases)), now, worldId, entityId)
    return this.getEntity(worldId, entityId)!
  }

  setEntityStatus(worldId: string, entityId: string, status: KnowledgeEntityStatus): KnowledgeEntity {
    assertEntityStatus(status)
    const entity = this.getEntity(worldId, entityId)
    if (entity === undefined) throw new EntityNotFoundError(`Knowledge entity not found: ${entityId}`)
    const now = this.#clock()
    this.#database.prepare(
      `UPDATE knowledge_entities SET status = ?, updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE NULL END
       WHERE world_id = ? AND id = ?`,
    ).run(status, now, status, now, worldId, entityId)
    return this.getEntity(worldId, entityId)!
  }

  getClaim(worldId: string, claimId: string): KnowledgeClaim | undefined {
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_claims WHERE world_id = ? AND id = ?',
    ).get(worldId, claimId)
    return row === undefined ? undefined : mapClaim(row)
  }

  listClaims(worldId: string, options?: KnowledgeStatementListFilter): KnowledgeClaim[]
  listClaims(input: { worldId: string; entityIds?: readonly string[]; limit: number; sourceType?: KnowledgeEvidenceSourceType }): KnowledgeClaim[]
  listClaims(worldOrInput: string | { worldId: string; entityIds?: readonly string[]; limit: number; sourceType?: KnowledgeEvidenceSourceType }, options: KnowledgeStatementListFilter = {}): KnowledgeClaim[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedOptions: KnowledgeStatementListFilter = typeof worldOrInput === 'string'
      ? options
      : { limit: worldOrInput.limit, ...(worldOrInput.entityIds === undefined ? {} : { entityIds: worldOrInput.entityIds }), ...(worldOrInput.sourceType === undefined ? {} : { sourceType: worldOrInput.sourceType }) }
    assertNonEmpty(worldId, 'World id')
    const clauses = ['world_id = ?']
    const params: Array<string | number> = [worldId]
    if (!resolvedOptions.includeArchived) clauses.push("status <> 'archived'")
    const entityIds = resolvedOptions.entityIds ?? (resolvedOptions.entityId === undefined ? undefined : [resolvedOptions.entityId])
    if (entityIds !== undefined && entityIds.length > 0) {
      const placeholders = entityIds.map(() => '?').join(', ')
      clauses.push(`(subject_entity_id IN (${placeholders}) OR object_entity_id IN (${placeholders}))`)
      params.push(...entityIds, ...entityIds)
    } else if (entityIds !== undefined) {
      return []
    }
    if (resolvedOptions.entityId !== undefined && entityIds === undefined) {
      clauses.push('(subject_entity_id = ? OR object_entity_id = ?)')
      params.push(resolvedOptions.entityId, resolvedOptions.entityId)
    }
    const limit = resolvedOptions.limit === undefined ? undefined : clampLimit(resolvedOptions.limit)
    const sourceType = resolvedOptions.sourceType
    const queryLimit = sourceType === undefined || sourceType === 'all' ? limit : undefined
    if (queryLimit !== undefined) { clauses.push('1 = 1'); params.push(queryLimit) }
    const claims = this.#database.prepare(
      `SELECT * FROM knowledge_claims WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC${queryLimit === undefined ? '' : ' LIMIT ?'}`,
    ).all(...params).map(mapClaim)
    if (sourceType === undefined || sourceType === 'all') return claims
    assertEvidenceSourceType(sourceType)
    return claims.filter((claim) => claim.evidenceIds.some((id) => this.getEvidence(worldId, id)?.sourceType === sourceType)).slice(0, limit)
  }

  searchClaims(worldId: string, query: string, limit: number): KnowledgeClaim[]
  searchClaims(input: { worldId: string; query: string; limit: number }): KnowledgeClaim[]
  searchClaims(worldOrInput: string | { worldId: string; query: string; limit: number }, query?: string, limit?: number): KnowledgeClaim[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedQuery = typeof worldOrInput === 'string' ? query : worldOrInput.query
    const resolvedLimit = typeof worldOrInput === 'string' ? limit : worldOrInput.limit
    assertNonEmpty(worldId, 'World id')
    const normalized = resolvedQuery?.trim() ?? ''
    if (!normalized) return []
    const contains = `%${escapeLike(normalized)}%`
    const prefix = `${escapeLike(normalized)}%`
    return this.#database.prepare(
      `SELECT claim.* FROM knowledge_claims AS claim
       INNER JOIN knowledge_entities AS subject ON subject.world_id = claim.world_id AND subject.id = claim.subject_entity_id
       LEFT JOIN knowledge_entities AS object ON object.world_id = claim.world_id AND object.id = claim.object_entity_id
       WHERE claim.world_id = ? AND claim.status = 'active'
         AND (claim.predicate LIKE ? ESCAPE '\\' OR claim.object_text LIKE ? ESCAPE '\\'
           OR subject.canonical_name LIKE ? ESCAPE '\\' OR object.canonical_name LIKE ? ESCAPE '\\')
       ORDER BY claim.predicate = ? COLLATE NOCASE DESC,
                claim.predicate LIKE ? ESCAPE '\\' COLLATE NOCASE DESC,
                claim.confidence DESC, claim.updated_at DESC, claim.id DESC
       LIMIT ?`,
    ).all(worldId, contains, contains, contains, contains, normalized, prefix, clampLimit(resolvedLimit ?? 20)).map(mapClaim)
  }

  upsertClaim(input: KnowledgeClaimInput): KnowledgeClaim {
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      const normalized = normalizeClaimInput(input)
      this.#assertEntityInWorld(world, normalized.subjectEntityId)
      if (normalized.objectEntityId !== undefined) this.#assertEntityInWorld(world, normalized.objectEntityId)
      this.#assertEvidenceInWorld(world, normalized.evidenceIds)
      if (normalized.supersededById !== undefined) this.#assertClaimInWorld(world, normalized.supersededById)
      if (normalized.source === 'auto' && normalized.status === 'active' && normalized.evidenceIds.length === 0) {
        throw new PersistenceError('Active automatically extracted claims require evidence')
      }
      if (normalized.source === 'auto' && this.isSuppressed(world.id, 'claim', claimFingerprint({
        subjectEntityId: normalized.subjectEntityId,
        predicate: normalized.predicate,
        ...(normalized.objectEntityId === undefined ? {} : { objectEntityId: normalized.objectEntityId }),
        ...(normalized.objectText === undefined ? {} : { objectText: normalized.objectText }),
      }))) {
        throw new PersistenceError('Knowledge claim is suppressed for this evidence')
      }
      const id = normalized.id ?? this.#idFactory()
      this.#assertGlobalOwnership('knowledge_claims', id, world, 'Knowledge claim')
      const now = normalized.createdAt ?? this.#clock()
      this.#database.prepare(
        `INSERT INTO knowledge_claims
         (id, workspace_id, world_id, type, subject_entity_id, predicate, object_entity_id, object_text,
          confidence, status, source, evidence_ids_json, conflict_group, superseded_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           type = excluded.type, subject_entity_id = excluded.subject_entity_id, predicate = excluded.predicate,
           object_entity_id = excluded.object_entity_id, object_text = excluded.object_text,
           confidence = excluded.confidence, status = excluded.status, source = excluded.source,
           evidence_ids_json = excluded.evidence_ids_json, conflict_group = excluded.conflict_group,
           superseded_by_id = excluded.superseded_by_id, updated_at = excluded.updated_at
         WHERE knowledge_claims.workspace_id = excluded.workspace_id AND knowledge_claims.world_id = excluded.world_id`,
      ).run(id, world.workspaceId, world.id, normalized.type, normalized.subjectEntityId, normalized.predicate,
        normalized.objectEntityId ?? null, normalized.objectText ?? null, normalized.confidence, normalized.status,
        normalized.source, stringifyJson(normalized.evidenceIds), normalized.conflictGroup ?? null,
        normalized.supersededById ?? null, now, this.#clock())
      const claim = this.getClaim(world.id, id)
      if (claim === undefined) throw new PersistenceError('Knowledge claim could not be read after save')
      return claim
    })
  }

  archiveClaim(worldId: string, claimId: string): KnowledgeClaim {
    return this.#withTransaction(() => {
      const claim = this.getClaim(worldId, claimId)
      if (claim === undefined) throw new EntityNotFoundError(`Knowledge claim not found: ${claimId}`)
      this.setStatementStatus('claim', worldId, claimId, 'archived')
      this.suppress(worldId, 'claim', claimFingerprint(claim), claim.evidenceIds)
      return this.getClaim(worldId, claimId)!
    })
  }

  /** Restore an archived claim and release the exact suppression created by archiving it. */
  restoreClaim(worldId: string, claimId: string): KnowledgeClaim {
    return this.#withTransaction(() => {
      const claim = this.getClaim(worldId, claimId)
      if (claim === undefined) throw new EntityNotFoundError(`Knowledge claim not found: ${claimId}`)
      if (claim.status === 'archived') {
        this.#removeSuppression(worldId, 'claim', claimFingerprint(claim))
        this.setStatementStatus('claim', worldId, claimId, 'active')
      }
      return this.getClaim(worldId, claimId)!
    })
  }

  getRelation(worldId: string, relationId: string): KnowledgeRelation | undefined {
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_relations WHERE world_id = ? AND id = ?',
    ).get(worldId, relationId)
    return row === undefined ? undefined : mapRelation(row)
  }

  listRelations(worldId: string, options?: KnowledgeStatementListFilter): KnowledgeRelation[]
  listRelations(input: { worldId: string; entityIds?: readonly string[]; limit: number; sourceType?: KnowledgeEvidenceSourceType }): KnowledgeRelation[]
  listRelations(worldOrInput: string | { worldId: string; entityIds?: readonly string[]; limit: number; sourceType?: KnowledgeEvidenceSourceType }, options: KnowledgeStatementListFilter = {}): KnowledgeRelation[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedOptions: KnowledgeStatementListFilter = typeof worldOrInput === 'string'
      ? options
      : { limit: worldOrInput.limit, ...(worldOrInput.entityIds === undefined ? {} : { entityIds: worldOrInput.entityIds }), ...(worldOrInput.sourceType === undefined ? {} : { sourceType: worldOrInput.sourceType }) }
    assertNonEmpty(worldId, 'World id')
    const clauses = ['world_id = ?']
    const params: Array<string | number> = [worldId]
    if (!resolvedOptions.includeArchived) clauses.push("status <> 'archived'")
    const entityIds = resolvedOptions.entityIds ?? (resolvedOptions.entityId === undefined ? undefined : [resolvedOptions.entityId])
    if (entityIds !== undefined && entityIds.length > 0) {
      const placeholders = entityIds.map(() => '?').join(', ')
      clauses.push(`(from_entity_id IN (${placeholders}) OR to_entity_id IN (${placeholders}))`)
      params.push(...entityIds, ...entityIds)
    } else if (entityIds !== undefined) {
      return []
    }
    if (resolvedOptions.entityId !== undefined && entityIds === undefined) {
      clauses.push('(from_entity_id = ? OR to_entity_id = ?)')
      params.push(resolvedOptions.entityId, resolvedOptions.entityId)
    }
    const limit = resolvedOptions.limit === undefined ? undefined : clampLimit(resolvedOptions.limit)
    const sourceType = resolvedOptions.sourceType
    const queryLimit = sourceType === undefined || sourceType === 'all' ? limit : undefined
    if (queryLimit !== undefined) params.push(queryLimit)
    const relations = this.#database.prepare(
      `SELECT * FROM knowledge_relations WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, id DESC${queryLimit === undefined ? '' : ' LIMIT ?'}`,
    ).all(...params).map(mapRelation)
    if (sourceType === undefined || sourceType === 'all') return relations
    assertEvidenceSourceType(sourceType)
    return relations.filter((relation) => relation.evidenceIds.some((id) => this.getEvidence(worldId, id)?.sourceType === sourceType)).slice(0, limit)
  }

  upsertRelation(input: KnowledgeRelationInput): KnowledgeRelation {
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      const normalized = normalizeRelationInput(input)
      this.#assertEntityInWorld(world, normalized.fromEntityId)
      this.#assertEntityInWorld(world, normalized.toEntityId)
      this.#assertEvidenceInWorld(world, normalized.evidenceIds)
      if (normalized.supersededById !== undefined) this.#assertRelationInWorld(world, normalized.supersededById)
      if (normalized.source === 'auto' && normalized.status === 'active' && normalized.evidenceIds.length === 0) {
        throw new PersistenceError('Active automatically extracted relations require evidence')
      }
      if (normalized.source === 'auto' && this.isSuppressed(world.id, 'relation', relationFingerprint(normalized))) {
        throw new PersistenceError('Knowledge relation is suppressed for this evidence')
      }
      const id = normalized.id ?? this.#idFactory()
      this.#assertGlobalOwnership('knowledge_relations', id, world, 'Knowledge relation')
      const now = normalized.createdAt ?? this.#clock()
      this.#database.prepare(
        `INSERT INTO knowledge_relations
         (id, workspace_id, world_id, from_entity_id, to_entity_id, predicate, confidence, status, source,
          evidence_ids_json, conflict_group, superseded_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           from_entity_id = excluded.from_entity_id, to_entity_id = excluded.to_entity_id,
           predicate = excluded.predicate, confidence = excluded.confidence, status = excluded.status,
           source = excluded.source, evidence_ids_json = excluded.evidence_ids_json,
           conflict_group = excluded.conflict_group, superseded_by_id = excluded.superseded_by_id,
           updated_at = excluded.updated_at
         WHERE knowledge_relations.workspace_id = excluded.workspace_id AND knowledge_relations.world_id = excluded.world_id`,
      ).run(id, world.workspaceId, world.id, normalized.fromEntityId, normalized.toEntityId, normalized.predicate,
        normalized.confidence, normalized.status, normalized.source, stringifyJson(normalized.evidenceIds),
        normalized.conflictGroup ?? null, normalized.supersededById ?? null, now, this.#clock())
      const relation = this.getRelation(world.id, id)
      if (relation === undefined) throw new PersistenceError('Knowledge relation could not be read after save')
      return relation
    })
  }

  archiveRelation(worldId: string, relationId: string): KnowledgeRelation {
    return this.#withTransaction(() => {
      const relation = this.getRelation(worldId, relationId)
      if (relation === undefined) throw new EntityNotFoundError(`Knowledge relation not found: ${relationId}`)
      this.setStatementStatus('relation', worldId, relationId, 'archived')
      this.suppress(worldId, 'relation', relationFingerprint(relation), relation.evidenceIds)
      return this.getRelation(worldId, relationId)!
    })
  }

  /** Restore an archived relation and release the exact suppression created by archiving it. */
  restoreRelation(worldId: string, relationId: string): KnowledgeRelation {
    return this.#withTransaction(() => {
      const relation = this.getRelation(worldId, relationId)
      if (relation === undefined) throw new EntityNotFoundError(`Knowledge relation not found: ${relationId}`)
      if (relation.status === 'archived') {
        this.#removeSuppression(worldId, 'relation', relationFingerprint(relation))
        this.setStatementStatus('relation', worldId, relationId, 'active')
      }
      return this.getRelation(worldId, relationId)!
    })
  }

  createEvidence(input: KnowledgeEvidenceInput): KnowledgeEvidence {
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      const normalized = normalizeEvidenceInput(input)
      this.#validateEvidenceSource(world, normalized)
      const id = normalized.id ?? this.#idFactory()
      this.#assertGlobalOwnership('knowledge_evidence', id, world, 'Knowledge evidence')
      const createdAt = normalized.createdAt ?? this.#clock()
      this.#database.prepare(
        `INSERT INTO knowledge_evidence
         (id, workspace_id, world_id, source_type, session_id, message_id, sequence, document_id, chunk_id,
          artifact_id, artifact_version, excerpt, note, source_weight, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, world.workspaceId, world.id, normalized.sourceType, normalized.sessionId ?? null,
        normalized.messageId ?? null, normalized.sequence ?? null, normalized.documentId ?? null,
        normalized.chunkId ?? null, normalized.artifactId ?? null, normalized.artifactVersion ?? null,
        normalized.excerpt, normalized.note ?? null, this.#evidenceWeight(world, normalized), normalized.createdBy ?? null, createdAt)
      const result = this.getEvidence(world.id, id)
      if (result === undefined) throw new PersistenceError('Knowledge evidence could not be read after insert')
      return result
    })
  }

  getEvidence(worldId: string, evidenceId: string): KnowledgeEvidence | undefined {
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_evidence WHERE world_id = ? AND id = ?',
    ).get(worldId, evidenceId)
    return row === undefined ? undefined : mapEvidence(row)
  }

  listEvidence(worldId: string, options?: KnowledgeEvidenceListFilter): KnowledgeEvidence[]
  listEvidence(input: { worldId: string; claimIds?: readonly string[]; relationIds?: readonly string[]; entityIds?: readonly string[]; limit: number; sourceType?: KnowledgeEvidenceSourceType }): KnowledgeEvidence[]
  listEvidence(worldOrInput: string | { worldId: string; claimIds?: readonly string[]; relationIds?: readonly string[]; entityIds?: readonly string[]; limit: number; sourceType?: KnowledgeEvidenceSourceType }, options: KnowledgeEvidenceListFilter = {}): KnowledgeEvidence[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedOptions: KnowledgeEvidenceListFilter & { claimIds?: readonly string[]; relationIds?: readonly string[]; entityIds?: readonly string[] } = typeof worldOrInput === 'string'
      ? options
      : { limit: worldOrInput.limit, ...(worldOrInput.claimIds === undefined ? {} : { claimIds: worldOrInput.claimIds }), ...(worldOrInput.relationIds === undefined ? {} : { relationIds: worldOrInput.relationIds }), ...(worldOrInput.entityIds === undefined ? {} : { entityIds: worldOrInput.entityIds }), ...(worldOrInput.sourceType === undefined ? {} : { sourceType: worldOrInput.sourceType }) }
    const evidenceIds = new Set<string>()
    const hasEvidenceFilter = resolvedOptions.claimId !== undefined || resolvedOptions.relationId !== undefined || resolvedOptions.entityId !== undefined || resolvedOptions.claimIds !== undefined || resolvedOptions.relationIds !== undefined || resolvedOptions.entityIds !== undefined
    const addClaimEvidence = (claimId: string) => { for (const id of this.getClaim(worldId, claimId)?.evidenceIds ?? []) evidenceIds.add(id) }
    const addRelationEvidence = (relationId: string) => { for (const id of this.getRelation(worldId, relationId)?.evidenceIds ?? []) evidenceIds.add(id) }
    if (resolvedOptions.claimId !== undefined) addClaimEvidence(resolvedOptions.claimId)
    if (resolvedOptions.relationId !== undefined) addRelationEvidence(resolvedOptions.relationId)
    for (const claimId of resolvedOptions.claimIds ?? []) addClaimEvidence(claimId)
    for (const relationId of resolvedOptions.relationIds ?? []) addRelationEvidence(relationId)
    const relatedEntityIds = resolvedOptions.entityIds ?? (resolvedOptions.entityId === undefined ? undefined : [resolvedOptions.entityId])
    for (const entityId of relatedEntityIds ?? []) {
      for (const claim of this.listClaims(worldId, { includeArchived: true, entityId })) for (const id of claim.evidenceIds) evidenceIds.add(id)
      for (const relation of this.listRelations(worldId, { includeArchived: true, entityId })) for (const id of relation.evidenceIds) evidenceIds.add(id)
    }
    const params: Array<string | number> = [worldId]
    const clauses = ['world_id = ?']
    if (hasEvidenceFilter) {
      if (evidenceIds.size === 0) return []
      const ids = [...evidenceIds]
      clauses.push(`id IN (${ids.map(() => '?').join(', ')})`)
      params.push(...ids)
    }
    if (resolvedOptions.sourceType !== undefined && resolvedOptions.sourceType !== 'all') {
      assertEvidenceSourceType(resolvedOptions.sourceType)
      clauses.push('source_type = ?')
      params.push(resolvedOptions.sourceType)
    }
    const limit = resolvedOptions.limit === undefined ? undefined : clampLimit(resolvedOptions.limit)
    if (limit !== undefined) params.push(limit)
    return this.#database.prepare(
      `SELECT * FROM knowledge_evidence WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC${limit === undefined ? '' : ' LIMIT ?'}`,
    ).all(...params).map(mapEvidence)
  }

  getGraph(worldId: string, query: KnowledgeGraphQuery = {}): KnowledgeGraphSnapshot {
    const sourceType = query.sourceType === undefined || query.sourceType === 'all' ? undefined : normalizeEvidenceSourceType(query.sourceType)
    const entities = this.listEntities(worldId, {
      ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
      ...(query.entityType === undefined ? {} : { type: query.entityType }),
      ...(sourceType === undefined ? {} : { sourceType }),
      limit: query.limit === undefined ? 300 : query.limit,
    })
    let selected = entities
    if (query.focusEntityId !== undefined) {
      const focus = this.getEntity(worldId, query.focusEntityId)
      if (focus === undefined) throw new EntityNotFoundError(`Knowledge entity not found: ${query.focusEntityId}`)
      const depth = query.depth ?? 1
      const ids = new Set([focus.id])
      for (let index = 0; index < depth; index += 1) {
        for (const relation of this.listRelations(worldId, {
          ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
          ...(sourceType === undefined ? {} : { sourceType }),
        })) {
          if (ids.has(relation.fromEntityId)) ids.add(relation.toEntityId)
          if (ids.has(relation.toEntityId)) ids.add(relation.fromEntityId)
        }
      }
      selected = entities.filter((entity) => ids.has(entity.id))
    }
    const selectedIds = new Set(selected.map((entity) => entity.id))
    const relations = this.listRelations(worldId, {
      ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
      ...(sourceType === undefined ? {} : { sourceType }),
    })
      .filter((relation) => selectedIds.has(relation.fromEntityId) && selectedIds.has(relation.toEntityId))
    const claims = this.listClaims(worldId, {
      ...(query.includeArchived === undefined ? {} : { includeArchived: query.includeArchived }),
      ...(sourceType === undefined ? {} : { sourceType }),
    })
      .filter((claim) => selectedIds.has(claim.subjectEntityId) || (claim.objectEntityId !== undefined && selectedIds.has(claim.objectEntityId)))
    const evidenceIds = new Set<string>()
    for (const claim of claims) for (const id of claim.evidenceIds) evidenceIds.add(id)
    for (const relation of relations) for (const id of relation.evidenceIds) evidenceIds.add(id)
    const evidence = [...evidenceIds].map((id) => this.getEvidence(worldId, id)).filter((item): item is KnowledgeEvidence => item !== undefined)
    return { worldId, entities: selected, claims, relations, evidence, generatedAt: this.#clock() }
  }

  getConversationCursor(worldId: string, sessionId: string): KnowledgeConversationCursor | undefined
  getConversationCursor(input: { workspaceId: string; worldId: string; sessionId: string }): KnowledgeConversationCursor | undefined
  getConversationCursor(worldOrInput: string | { workspaceId: string; worldId: string; sessionId: string }, sessionId?: string): KnowledgeConversationCursor | undefined {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedSessionId = typeof worldOrInput === 'string' ? sessionId : worldOrInput.sessionId
    if (resolvedSessionId === undefined) throw new PersistenceError('Knowledge session id is required')
    if (typeof worldOrInput !== 'string') this.#assertWorld(worldOrInput.workspaceId, worldId)
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_conversation_cursors WHERE world_id = ? AND session_id = ?',
    ).get(worldId, resolvedSessionId)
    return row === undefined ? undefined : mapCursor(row)
  }

  advanceConversationCursor(input: KnowledgeCursorAdvanceInput): KnowledgeConversationCursor {
    assertSequence(input.expectedThroughSequence)
    assertSequence(input.processedThroughSequence)
    if (input.processedThroughSequence < input.expectedThroughSequence) throw new PersistenceError('Knowledge cursor cannot move backwards')
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      this.#assertSessionInWorld(world, input.sessionId)
      const current = this.getConversationCursor(world.id, input.sessionId)
      const actual = current?.processedThroughSequence ?? 0
      if (actual !== input.expectedThroughSequence) throw new PersistenceError('Knowledge cursor changed concurrently')
      const updatedAt = this.#clock()
      this.#database.prepare(
        `INSERT INTO knowledge_conversation_cursors (workspace_id, world_id, session_id, processed_through_sequence, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (world_id, session_id) DO UPDATE SET processed_through_sequence = excluded.processed_through_sequence, updated_at = excluded.updated_at`,
      ).run(world.workspaceId, world.id, input.sessionId, input.processedThroughSequence, updatedAt)
      return this.getConversationCursor(world.id, input.sessionId)!
    })
  }

  enqueueConsolidationJob(input: KnowledgeConsolidationJobInput): KnowledgeConsolidationJob {
    assertSequence(input.fromCursor)
    assertSequence(input.toCursor)
    if (input.toCursor < input.fromCursor) throw new PersistenceError('Knowledge consolidation cursor range is invalid')
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      this.#assertConsolidationSource(world, input.sourceType, input.sourceId.trim())
      const id = input.id?.trim() || this.#idFactory()
      const now = input.createdAt ?? this.#clock()
      this.#database.prepare(
        `INSERT INTO knowledge_consolidation_jobs
         (id, workspace_id, world_id, source_type, source_id, from_cursor, to_cursor, status, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
         ON CONFLICT (world_id, source_type, source_id, from_cursor, to_cursor) DO NOTHING`,
      ).run(id, world.workspaceId, world.id, input.sourceType, input.sourceId.trim(), input.fromCursor, input.toCursor, now, now)
      const row = this.#database.prepare(
        `SELECT * FROM knowledge_consolidation_jobs WHERE world_id = ? AND source_type = ? AND source_id = ? AND from_cursor = ? AND to_cursor = ?`,
      ).get(world.id, input.sourceType, input.sourceId.trim(), input.fromCursor, input.toCursor)
      if (row === undefined) throw new PersistenceError('Knowledge consolidation job could not be read after enqueue')
      return mapJob(row)
    })
  }

  getConsolidationJob(worldId: string, jobId: string): KnowledgeConsolidationJob | undefined {
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_consolidation_jobs WHERE world_id = ? AND id = ?',
    ).get(worldId, jobId)
    return row === undefined ? undefined : mapJob(row)
  }

  /** Provider-neutral object form used by the background consolidation service. */
  createConsolidationJob(input: {
    id?: string
    workspaceId: string
    worldId: string
    sourceType: KnowledgeEvidenceSourceType
    sourceId: string
    fromCursor?: number
    toCursor?: number
    createdAt?: string
  }): KnowledgeConsolidationJob {
    const sourceType = input.sourceType
    if (sourceType === 'manual') throw new PersistenceError('Manual knowledge does not use a consolidation job')
    const cursor = sourceType === 'conversation'
      ? this.getConversationCursor(input.worldId, input.sourceId)?.processedThroughSequence ?? 0
      : 0
    const fromCursor = input.fromCursor ?? cursor
    const toCursor = input.toCursor ?? (sourceType === 'conversation'
      ? fromCursor
      : this.#consolidationSourceRevision(input.worldId, sourceType, input.sourceId))
    return this.enqueueConsolidationJob({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sourceType,
      sourceId: input.sourceId,
      fromCursor,
      toCursor,
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
  }

  listConsolidationJobs(worldId: string, status?: KnowledgeConsolidationJob['status']): KnowledgeConsolidationJob[]
  listConsolidationJobs(input: { status?: KnowledgeConsolidationJob['status']; worldId?: string; limit: number }): KnowledgeConsolidationJob[]
  listConsolidationJobs(worldOrInput: string | { status?: KnowledgeConsolidationJob['status']; worldId?: string; limit: number }, status?: KnowledgeConsolidationJob['status']): KnowledgeConsolidationJob[] {
    const worldId = typeof worldOrInput === 'string' ? worldOrInput : worldOrInput.worldId
    const resolvedStatus = typeof worldOrInput === 'string' ? status : worldOrInput.status
    const limit = typeof worldOrInput === 'string' ? undefined : clampLimit(worldOrInput.limit)
    if (worldId !== undefined) this.#assertWorldById(worldId)
    if (resolvedStatus !== undefined && !['queued', 'running', 'completed', 'failed'].includes(resolvedStatus)) {
      throw new PersistenceError(`Unknown knowledge consolidation job status: ${resolvedStatus}`)
    }
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (worldId !== undefined) { clauses.push('world_id = ?'); params.push(worldId) }
    if (resolvedStatus !== undefined) { clauses.push('status = ?'); params.push(resolvedStatus) }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const limitSql = limit === undefined ? '' : ' LIMIT ?'
    if (limit !== undefined) params.push(limit)
    const rows = this.#database.prepare(`SELECT * FROM knowledge_consolidation_jobs${where} ORDER BY created_at DESC, id DESC${limitSql}`).all(...params)
    return rows.map(mapJob)
  }

  /** Requeue work that was interrupted by a process restart; no extraction is retried here. */
  recoverRunningConsolidationJobs(worldId?: string): number {
    const now = this.#clock()
    const result = worldId === undefined
      ? this.#database.prepare("UPDATE knowledge_consolidation_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now)
      : this.#database.prepare("UPDATE knowledge_consolidation_jobs SET status = 'queued', updated_at = ? WHERE world_id = ? AND status = 'running'").run(now, worldId)
    return Number(result.changes)
  }

  claimNextConsolidationJob(worldId: string): KnowledgeConsolidationJob | undefined {
    return this.#withTransaction(() => {
      const candidate = this.#database.prepare(
        `SELECT * FROM knowledge_consolidation_jobs WHERE world_id = ? AND status = 'queued'
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      ).get(worldId)
      if (candidate === undefined) return undefined
      const row = record(candidate)
      const id = String(row.id)
      const now = this.#clock()
      const result = this.#database.prepare(
        `UPDATE knowledge_consolidation_jobs SET status = 'running', attempt = attempt + 1, started_at = ?, updated_at = ?, error_code = NULL
         WHERE world_id = ? AND id = ? AND status = 'queued'`,
      ).run(now, now, worldId, id)
      if (Number(result.changes) !== 1) return undefined
      return this.getConsolidationJob(worldId, id)
    })
  }

  claimConsolidationJob(jobId: string): KnowledgeConsolidationJob | undefined {
    return this.#withTransaction(() => {
      const candidate = this.#database.prepare(
        `SELECT world_id FROM knowledge_consolidation_jobs WHERE id = ? AND status = 'queued'`,
      ).get(jobId) as Record<string, unknown> | undefined
      if (candidate === undefined) return undefined
      const worldId = String(candidate.world_id)
      const now = this.#clock()
      const result = this.#database.prepare(
        `UPDATE knowledge_consolidation_jobs SET status = 'running', attempt = attempt + 1, started_at = ?, updated_at = ?, error_code = NULL
         WHERE world_id = ? AND id = ? AND status = 'queued'`,
      ).run(now, now, worldId, jobId)
      if (Number(result.changes) !== 1) return undefined
      return this.getConsolidationJob(worldId, jobId)
    })
  }

  completeConsolidationJob(input: { jobId: string; toCursor?: number; completedAt?: string }): KnowledgeConsolidationJob
  completeConsolidationJob(worldId: string, jobId: string): KnowledgeConsolidationJob
  completeConsolidationJob(worldOrInput: string | { jobId: string; toCursor?: number; completedAt?: string }, jobId?: string): KnowledgeConsolidationJob {
    if (typeof worldOrInput === 'string') return this.updateJob(worldOrInput, jobId!, 'completed')
    const row = this.#database.prepare('SELECT world_id FROM knowledge_consolidation_jobs WHERE id = ?').get(worldOrInput.jobId) as Record<string, unknown> | undefined
    if (row === undefined) throw new EntityNotFoundError(`Knowledge consolidation job not found: ${worldOrInput.jobId}`)
    const worldId = String(row.world_id)
    return this.#withTransaction(() => {
      const current = this.getConsolidationJob(worldId, worldOrInput.jobId)
      if (current === undefined) throw new EntityNotFoundError(`Knowledge consolidation job not found: ${worldOrInput.jobId}`)
      if (current.status === 'completed' || current.status === 'failed') return current
      if (worldOrInput.toCursor !== undefined) {
        assertSequence(worldOrInput.toCursor)
        if (worldOrInput.toCursor < current.fromCursor) throw new PersistenceError('Knowledge consolidation cursor range is invalid')
      }
      const completedAt = worldOrInput.completedAt ?? this.#clock()
      this.#database.prepare(
        `UPDATE knowledge_consolidation_jobs SET status = 'completed', error_code = NULL, to_cursor = COALESCE(?, to_cursor), updated_at = ?, completed_at = ?
         WHERE world_id = ? AND id = ?`,
      ).run(worldOrInput.toCursor ?? null, completedAt, completedAt, worldId, worldOrInput.jobId)
      if (current.sourceType === 'conversation' && worldOrInput.toCursor !== undefined) {
        const sessionCursor = this.getConversationCursor(worldId, current.sourceId)
        const expected = sessionCursor?.processedThroughSequence ?? 0
        if (worldOrInput.toCursor >= expected) {
          const world = this.#assertWorldById(worldId)
          this.#database.prepare(
            `INSERT INTO knowledge_conversation_cursors (workspace_id, world_id, session_id, processed_through_sequence, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (world_id, session_id) DO UPDATE SET processed_through_sequence = excluded.processed_through_sequence, updated_at = excluded.updated_at`,
          ).run(world.workspaceId, worldId, current.sourceId, worldOrInput.toCursor, completedAt)
        }
      }
      return this.getConsolidationJob(worldId, worldOrInput.jobId)!
    })
  }

  failConsolidationJob(input: { jobId: string; errorCode: string }): KnowledgeConsolidationJob
  failConsolidationJob(worldId: string, jobId: string, errorCode: string): KnowledgeConsolidationJob
  failConsolidationJob(worldOrInput: string | { jobId: string; errorCode: string }, jobIdOrCode?: string, maybeErrorCode?: string): KnowledgeConsolidationJob {
    if (typeof worldOrInput === 'string') {
      const code = maybeErrorCode?.trim() ?? ''
      if (!code) throw new PersistenceError('Knowledge consolidation error code cannot be empty')
      if (jobIdOrCode === undefined) throw new PersistenceError('Knowledge consolidation job id cannot be empty')
      return this.updateJob(worldOrInput, jobIdOrCode, 'failed', code)
    }
    const row = this.#database.prepare('SELECT world_id FROM knowledge_consolidation_jobs WHERE id = ?').get(worldOrInput.jobId) as Record<string, unknown> | undefined
    if (row === undefined) throw new EntityNotFoundError(`Knowledge consolidation job not found: ${worldOrInput.jobId}`)
    const code = worldOrInput.errorCode.trim()
    if (!code) throw new PersistenceError('Knowledge consolidation error code cannot be empty')
    return this.updateJob(String(row.world_id), worldOrInput.jobId, 'failed', code)
  }

  requeueConsolidationJob(worldId: string, jobId: string): KnowledgeConsolidationJob {
    const current = this.getConsolidationJob(worldId, jobId)
    if (current === undefined) throw new EntityNotFoundError(`Knowledge consolidation job not found: ${jobId}`)
    if (current.status === 'queued') return current
    if (current.status !== 'failed') throw new PersistenceError('Only failed knowledge consolidation jobs can be retried')
    const updatedAt = this.#clock()
    const result = this.#database.prepare(
      `UPDATE knowledge_consolidation_jobs
       SET status = 'queued', error_code = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
       WHERE world_id = ? AND id = ? AND status = 'failed'`,
    ).run(updatedAt, worldId, jobId)
    if (result.changes !== 1) throw new PersistenceError('Knowledge consolidation job changed concurrently')
    return this.getConsolidationJob(worldId, jobId)!
  }

  /**
   * Atomically applies a validated, provider-neutral extraction batch. The
   * same evidence and statement fingerprint is reused on a retry, so a job
   * can safely be replayed after a process restart without duplicating graph
   * rows. This method accepts structural extraction data and does not import
   * any model-provider or server service type.
   */
  applyKnowledgeExtraction(input: {
    jobId: string
    workspaceId: string
    worldId: string
    extraction: KnowledgeExtractionPayload
    evidence: readonly KnowledgeExtractionEvidenceInput[]
    sourceType: KnowledgeEvidenceSourceType
    sourceId: string
    now: string
  }): void {
    this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      const job = this.getConsolidationJob(world.id, input.jobId)
      if (job === undefined) throw new EntityNotFoundError(`Knowledge consolidation job not found: ${input.jobId}`)
      if (job.workspaceId !== world.workspaceId || job.sourceType !== input.sourceType || job.sourceId !== input.sourceId) {
        throw new PersistenceError('Knowledge extraction job scope mismatch')
      }
      this.#applyExtractionRows(world, input.extraction, input.evidence, input.sourceType, input.sourceId, input.now, 'auto')
    })
  }

  /** Apply owner-confirmed manual knowledge without manufacturing a queued job. */
  applyManualKnowledgeExtraction(input: {
    workspaceId: string
    worldId: string
    extraction: KnowledgeExtractionPayload
    evidence: readonly KnowledgeExtractionEvidenceInput[]
    sourceId: string
    now: string
  }): void {
    this.#withTransaction(() => {
      const world = this.#assertWorld(input.workspaceId, input.worldId)
      this.#applyExtractionRows(world, input.extraction, input.evidence, 'manual', input.sourceId, input.now, 'manual')
    })
  }

  getWorldKnowledgeSettings(worldId: string): WorldKnowledgeSettings {
    const world = this.#assertWorldById(worldId)
    const row = this.#database.prepare('SELECT * FROM world_knowledge_settings WHERE world_id = ?').get(world.id)
    if (row === undefined) {
      return { workspaceId: world.workspaceId, worldId: world.id, retrievalEnabled: true, autoConsolidationMode: 'balanced', updatedAt: world.updatedAt }
    }
    return mapSettings(row)
  }

  getKnowledgeConsolidationSettings(worldId: string): WorldKnowledgeSettings {
    return this.getWorldKnowledgeSettings(worldId)
  }

  getKnowledgeConsolidationCursor(input: { worldId: string; sourceType: KnowledgeEvidenceSourceType; sourceId: string }): (KnowledgeConversationCursor & { sourceType: KnowledgeEvidenceSourceType; sourceId: string }) | undefined {
    if (input.sourceType !== 'conversation') return undefined
    const cursor = this.getConversationCursor(input.worldId, input.sourceId)
    if (cursor === undefined) return undefined
    return { ...cursor, sourceType: input.sourceType, sourceId: input.sourceId }
  }

  saveWorldKnowledgeSettings(input: Omit<WorldKnowledgeSettings, 'updatedAt'> & { updatedAt?: string }): WorldKnowledgeSettings {
    const world = this.#assertWorld(input.workspaceId, input.worldId)
    if (input.autoConsolidationMode !== 'off' && input.autoConsolidationMode !== 'balanced') throw new PersistenceError('Unknown knowledge consolidation mode')
    const extractionModelProfileId = input.extractionModelProfileId?.trim() || undefined
    const now = input.updatedAt ?? this.#clock()
    this.#database.prepare(
      `INSERT INTO world_knowledge_settings (workspace_id, world_id, retrieval_enabled, auto_consolidation_mode, extraction_model_profile_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (world_id) DO UPDATE SET retrieval_enabled = excluded.retrieval_enabled,
         auto_consolidation_mode = excluded.auto_consolidation_mode, extraction_model_profile_id = excluded.extraction_model_profile_id,
         updated_at = excluded.updated_at`,
    ).run(world.workspaceId, world.id, input.retrievalEnabled ? 1 : 0, input.autoConsolidationMode, extractionModelProfileId ?? null, now)
    return this.getWorldKnowledgeSettings(world.id)
  }

  isSuppressed(worldId: string, targetType: KnowledgeSuppressionTarget, fingerprint: string): boolean {
    assertSuppressionTarget(targetType)
    return this.#database.prepare(
      'SELECT 1 FROM knowledge_suppressions WHERE world_id = ? AND target_type = ? AND fingerprint = ?',
    ).get(worldId, targetType, fingerprint.trim()) !== undefined
  }

  suppress(worldId: string, targetType: KnowledgeSuppressionTarget, fingerprint: string, evidenceIds: string[] = []): KnowledgeSuppression {
    assertSuppressionTarget(targetType)
    const entity = this.#assertWorldById(worldId)
    this.#assertEvidenceInWorld(entity, evidenceIds)
    const normalized = fingerprint.trim()
    if (!normalized) throw new PersistenceError('Knowledge suppression fingerprint cannot be empty')
    const id = this.#idFactory()
    const now = this.#clock()
    this.#database.prepare(
      `INSERT INTO knowledge_suppressions (id, workspace_id, world_id, target_type, fingerprint, evidence_ids_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (world_id, target_type, fingerprint) DO UPDATE SET evidence_ids_json = excluded.evidence_ids_json`,
    ).run(id, entity.workspaceId, entity.id, targetType, normalized, stringifyJson(uniqueStrings(evidenceIds)), now)
    const row = this.#database.prepare(
      'SELECT * FROM knowledge_suppressions WHERE world_id = ? AND target_type = ? AND fingerprint = ?',
    ).get(entity.id, targetType, normalized)
    if (row === undefined) throw new PersistenceError('Knowledge suppression could not be read after insert')
    return mapSuppression(row)
  }

  listSuppressions(worldId: string): KnowledgeSuppression[] {
    this.#assertWorldById(worldId)
    return this.#database.prepare(
      'SELECT * FROM knowledge_suppressions WHERE world_id = ? ORDER BY created_at DESC, id DESC',
    ).all(worldId).map(mapSuppression)
  }

  #applyExtractionRows(
    world: { id: string; workspaceId: string },
    extraction: KnowledgeExtractionPayload,
    evidence: readonly KnowledgeExtractionEvidenceInput[],
    sourceType: KnowledgeEvidenceSourceType,
    sourceId: string,
    now: string,
    statementSource: KnowledgeStatementSource,
  ): void {
    const evidenceById = new Map<string, KnowledgeEvidence>()
    for (const item of evidence) {
      const evidenceId = item.evidenceId.trim()
      if (!evidenceId) throw new PersistenceError('Knowledge evidence id cannot be empty')
      if (evidenceById.has(evidenceId)) throw new PersistenceError('Knowledge evidence id is duplicated')
      if (item.workspaceId !== world.workspaceId || item.worldId !== world.id || item.sourceType !== sourceType || item.sourceId !== sourceId) {
        throw new PersistenceError('Knowledge evidence source scope mismatch')
      }
      const existingScope = this.#database.prepare('SELECT workspace_id, world_id FROM knowledge_evidence WHERE id = ?').get(evidenceId) as Record<string, unknown> | undefined
      if (existingScope !== undefined && (String(existingScope.workspace_id) !== world.workspaceId || String(existingScope.world_id) !== world.id)) {
        throw new PersistenceError(`Knowledge evidence is owned by another world: ${evidenceId}`)
      }
      const existing = this.getEvidence(world.id, evidenceId)
      if (existing !== undefined) {
        if (!evidenceMatchesInput(existing, item)) throw new PersistenceError(`Knowledge evidence source changed: ${evidenceId}`)
        evidenceById.set(evidenceId, existing)
        continue
      }
      const created = this.createEvidence(toEvidenceInput(item, evidenceId, now))
      evidenceById.set(evidenceId, created)
    }

    const declaredEvidence = new Map<string, { sourceType: KnowledgeEvidenceSourceType; sourceId: string }>()
    for (const reference of extraction.evidenceRefs) {
      const evidenceId = reference.evidenceId.trim()
      if (declaredEvidence.has(evidenceId)) throw new PersistenceError('Knowledge extraction evidence reference is duplicated')
      const item = evidenceById.get(evidenceId)
      if (item === undefined || reference.sourceType !== sourceType || reference.sourceId !== sourceId || item.sourceType !== reference.sourceType) {
        throw new PersistenceError('Knowledge extraction evidence reference is outside the current batch')
      }
      declaredEvidence.set(evidenceId, { sourceType: reference.sourceType, sourceId: reference.sourceId })
    }
    const resolveEvidence = (references: readonly string[]): string[] => {
      const ids = uniqueStrings(references)
      if (ids.length === 0) throw new PersistenceError('Automatically extracted knowledge requires evidence')
      if (ids.some((id) => !declaredEvidence.has(id))) throw new PersistenceError('Knowledge extraction references undeclared evidence')
      return ids
    }

    const entityIds = new Map<string, string>()
    for (const item of extraction.entities) {
      const key = item.key.trim()
      const canonicalName = item.canonicalName.trim()
      if (!key || !canonicalName) throw new PersistenceError('Knowledge extraction entity key or name is empty')
      resolveEvidence(item.evidenceRefs)
      const existingRow = this.#database.prepare(
        `SELECT * FROM knowledge_entities WHERE world_id = ? AND lower(canonical_name) = lower(?)
         ORDER BY status = 'active' DESC, updated_at DESC, id DESC LIMIT 1`,
      ).get(world.id, canonicalName)
      const entity = existingRow === undefined
        ? this.upsertEntity({ workspaceId: world.workspaceId, worldId: world.id, type: item.type, canonicalName, aliases: item.aliases, ...(item.summary === undefined ? {} : { summary: item.summary }) })
        : mapEntity(existingRow)
      entityIds.set(key, entity.id)
    }

    const claims = this.listClaims(world.id, { includeArchived: true })
    for (const item of extraction.claims) {
      const subjectEntityId = entityIds.get(item.subjectKey.trim())
      if (subjectEntityId === undefined) throw new PersistenceError(`Knowledge claim subject is unknown: ${item.subjectKey}`)
      const evidenceIds = resolveEvidence(item.evidenceRefs)
      const objectEntityId = item.objectKey === undefined ? undefined : entityIds.get(item.objectKey.trim())
      const objectText = item.objectText?.trim() || undefined
      if ((objectEntityId === undefined) === (objectText === undefined)) throw new PersistenceError('Knowledge claim needs exactly one object')
      const candidate = {
        subjectEntityId, predicate: item.predicate.trim(), evidenceIds,
        ...(objectEntityId === undefined ? {} : { objectEntityId }),
        ...(objectText === undefined ? {} : { objectText }),
      }
      const exact = claims.find((claim) => claimFingerprint(claim) === claimFingerprint(candidate))
      if (exact !== undefined) {
        if (exact.status === 'archived') continue
        const merged = this.upsertClaim({ ...exact, evidenceIds: uniqueStrings([...exact.evidenceIds, ...evidenceIds]), confidence: Math.max(exact.confidence, item.confidence) })
        claims.splice(claims.indexOf(exact), 1, merged)
        continue
      }
      const competing = claims.filter((claim) => claim.status !== 'archived' && claim.status !== 'superseded' && claim.subjectEntityId === subjectEntityId && claim.predicate.toLocaleLowerCase() === candidate.predicate.toLocaleLowerCase())
      const candidateWeight = Math.max(...evidenceIds.map((id) => evidenceById.get(id)?.sourceWeight ?? 0))
      const existingWeight = Math.max(0, ...competing.flatMap((claim) => claim.evidenceIds.map((id) => this.getEvidence(world.id, id)?.sourceWeight ?? 0)))
      const conflictGroup = competing[0]?.conflictGroup ?? (competing.length === 0 ? undefined : this.#idFactory())
      const saved = this.upsertClaim({
        workspaceId: world.workspaceId,
        worldId: world.id,
        type: item.type,
        ...candidate,
        confidence: item.confidence,
        source: statementSource,
        status: competing.length === 0 || candidateWeight > existingWeight ? 'active' : 'conflicted',
        ...(conflictGroup === undefined ? {} : { conflictGroup }),
      })
      if (competing.length > 0 && candidateWeight > existingWeight) {
        for (const claim of competing) {
          this.#database.prepare(`UPDATE knowledge_claims SET status = 'superseded', conflict_group = ?, superseded_by_id = ?, updated_at = ? WHERE world_id = ? AND id = ?`)
            .run(conflictGroup!, saved.id, now, world.id, claim.id)
        }
      } else if (conflictGroup !== undefined) {
        for (const claim of competing) this.#database.prepare('UPDATE knowledge_claims SET conflict_group = ?, updated_at = ? WHERE world_id = ? AND id = ?').run(conflictGroup, now, world.id, claim.id)
      }
      claims.push(saved)
    }

    const relations = this.listRelations(world.id, { includeArchived: true })
    for (const item of extraction.relations) {
      const fromEntityId = entityIds.get(item.fromKey.trim())
      const toEntityId = entityIds.get(item.toKey.trim())
      if (fromEntityId === undefined || toEntityId === undefined) throw new PersistenceError('Knowledge relation entity is unknown')
      const evidenceIds = resolveEvidence(item.evidenceRefs)
      const candidate = { fromEntityId, toEntityId, predicate: item.predicate.trim(), evidenceIds }
      const exact = relations.find((relation) => relationFingerprint(relation) === relationFingerprint(candidate))
      if (exact !== undefined) {
        if (exact.status === 'archived') continue
        const merged = this.upsertRelation({ ...exact, evidenceIds: uniqueStrings([...exact.evidenceIds, ...evidenceIds]), confidence: Math.max(exact.confidence, item.confidence) })
        relations.splice(relations.indexOf(exact), 1, merged)
        continue
      }
      const competing = relations.filter((relation) => relation.status !== 'archived' && relation.status !== 'superseded' && relation.fromEntityId === fromEntityId && relation.predicate.toLocaleLowerCase() === candidate.predicate.toLocaleLowerCase())
      const candidateWeight = Math.max(...evidenceIds.map((id) => evidenceById.get(id)?.sourceWeight ?? 0))
      const existingWeight = Math.max(0, ...competing.flatMap((relation) => relation.evidenceIds.map((id) => this.getEvidence(world.id, id)?.sourceWeight ?? 0)))
      const conflictGroup = competing[0]?.conflictGroup ?? (competing.length === 0 ? undefined : this.#idFactory())
      const saved = this.upsertRelation({
        workspaceId: world.workspaceId,
        worldId: world.id,
        ...candidate,
        confidence: item.confidence,
        source: statementSource,
        status: competing.length === 0 || candidateWeight > existingWeight ? 'active' : 'conflicted',
        ...(conflictGroup === undefined ? {} : { conflictGroup }),
      })
      if (competing.length > 0 && candidateWeight > existingWeight) {
        for (const relation of competing) {
          this.#database.prepare(`UPDATE knowledge_relations SET status = 'superseded', conflict_group = ?, superseded_by_id = ?, updated_at = ? WHERE world_id = ? AND id = ?`)
            .run(conflictGroup!, saved.id, now, world.id, relation.id)
        }
      } else if (conflictGroup !== undefined) {
        for (const relation of competing) this.#database.prepare('UPDATE knowledge_relations SET conflict_group = ?, updated_at = ? WHERE world_id = ? AND id = ?').run(conflictGroup, now, world.id, relation.id)
      }
      relations.push(saved)
    }
  }

  #removeSuppression(worldId: string, targetType: KnowledgeSuppressionTarget, fingerprint: string): void {
    this.#database.prepare(
      'DELETE FROM knowledge_suppressions WHERE world_id = ? AND target_type = ? AND fingerprint = ?',
    ).run(worldId, targetType, fingerprint)
  }

  #assertWorld(workspaceId: string, worldId: string): { id: string; workspaceId: string; updatedAt: string } {
    const row = this.#database.prepare('SELECT id, workspace_id, updated_at FROM worlds WHERE id = ?').get(worldId) as Record<string, unknown> | undefined
    if (row === undefined) throw new EntityNotFoundError(`World not found: ${worldId}`)
    if (String(row.workspace_id) !== workspaceId) throw new PersistenceError('Knowledge world workspace scope mismatch')
    return { id: String(row.id), workspaceId: String(row.workspace_id), updatedAt: String(row.updated_at) }
  }

  #assertWorldById(worldId: string): { id: string; workspaceId: string; updatedAt: string } {
    const row = this.#database.prepare('SELECT id, workspace_id, updated_at FROM worlds WHERE id = ?').get(worldId) as Record<string, unknown> | undefined
    if (row === undefined) throw new EntityNotFoundError(`World not found: ${worldId}`)
    return { id: String(row.id), workspaceId: String(row.workspace_id), updatedAt: String(row.updated_at) }
  }

  #assertEntityInWorld(world: { id: string; workspaceId: string }, entityId: string): KnowledgeEntity {
    const entity = this.getEntity(world.id, entityId)
    if (entity === undefined || entity.workspaceId !== world.workspaceId) throw new PersistenceError(`Knowledge entity is outside this world: ${entityId}`)
    return entity
  }

  #assertClaimInWorld(world: { id: string; workspaceId: string }, claimId: string): KnowledgeClaim {
    const claim = this.getClaim(world.id, claimId)
    if (claim === undefined || claim.workspaceId !== world.workspaceId) throw new PersistenceError(`Knowledge claim is outside this world: ${claimId}`)
    return claim
  }

  #assertRelationInWorld(world: { id: string; workspaceId: string }, relationId: string): KnowledgeRelation {
    const relation = this.getRelation(world.id, relationId)
    if (relation === undefined || relation.workspaceId !== world.workspaceId) throw new PersistenceError(`Knowledge relation is outside this world: ${relationId}`)
    return relation
  }

  #assertGlobalOwnership(table: 'knowledge_entities' | 'knowledge_claims' | 'knowledge_relations' | 'knowledge_evidence', id: string, world: { id: string; workspaceId: string }, label: string): void {
    const row = this.#database.prepare(`SELECT workspace_id, world_id FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (row !== undefined && (String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id)) {
      throw new PersistenceError(`${label} is owned by another world: ${id}`)
    }
  }

  #assertSessionInWorld(world: { id: string; workspaceId: string }, sessionId: string): void {
    const row = this.#database.prepare('SELECT workspace_id, world_id FROM work_sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined
    if (row === undefined || String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id) {
      throw new PersistenceError(`Knowledge session is outside this world: ${sessionId}`)
    }
  }

  #assertConsolidationSource(world: { id: string; workspaceId: string }, sourceType: KnowledgeConsolidationJob['sourceType'], sourceId: string): void {
    if (!sourceId) throw new PersistenceError('Knowledge consolidation source id cannot be empty')
    if (sourceType === 'conversation') {
      this.#assertSessionInWorld(world, sourceId)
      return
    }
    const table = sourceType === 'document' ? 'knowledge_documents' : 'world_artifacts'
    const row = this.#database.prepare(`SELECT workspace_id, world_id FROM ${table} WHERE id = ?`).get(sourceId) as Record<string, unknown> | undefined
    if (row === undefined || String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id) {
      throw new PersistenceError(`Knowledge consolidation source is outside this world: ${sourceId}`)
    }
  }

  #consolidationSourceRevision(worldId: string, sourceType: 'document' | 'artifact', sourceId: string): number {
    const table = sourceType === 'document' ? 'knowledge_documents' : 'world_artifacts'
    const row = this.#database.prepare(`SELECT updated_at FROM ${table} WHERE world_id = ? AND id = ?`).get(worldId, sourceId) as Record<string, unknown> | undefined
    if (row === undefined || typeof row.updated_at !== 'string') throw new PersistenceError('Knowledge consolidation source is unavailable')
    const revision = Date.parse(row.updated_at)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new PersistenceError('Knowledge consolidation source revision is invalid')
    return revision
  }

  #assertEvidenceInWorld(world: { id: string; workspaceId: string }, evidenceIds: readonly string[]): void {
    for (const evidenceId of uniqueStrings(evidenceIds)) {
      const evidence = this.getEvidence(world.id, evidenceId)
      if (evidence === undefined || evidence.workspaceId !== world.workspaceId) throw new PersistenceError(`Knowledge evidence is outside this world: ${evidenceId}`)
    }
  }

  #entityHasEvidenceSource(worldId: string, entityId: string, sourceType: KnowledgeEvidenceSourceType): boolean {
    const claim = this.listClaims(worldId, { includeArchived: true, entityId })
      .some((item) => item.evidenceIds.some((id) => this.getEvidence(worldId, id)?.sourceType === sourceType))
    if (claim) return true
    return this.listRelations(worldId, { includeArchived: true, entityId })
      .some((item) => item.evidenceIds.some((id) => this.getEvidence(worldId, id)?.sourceType === sourceType))
  }

  #validateEvidenceSource(world: { id: string; workspaceId: string }, input: NormalizedEvidenceInput): void {
    if (input.sourceType === 'conversation') {
      const row = this.#database.prepare(
        `SELECT sessions.workspace_id, sessions.world_id, messages.sender_kind, messages.kind
         FROM messages INNER JOIN work_sessions AS sessions ON sessions.id = messages.session_id
         WHERE messages.id = ? AND messages.session_id = ? AND messages.sequence = ?`,
      ).get(input.messageId!, input.sessionId!, input.sequence!) as Record<string, unknown> | undefined
      if (row === undefined || String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id) throw new PersistenceError('Conversation evidence is outside this world')
      if (row.kind !== 'user' && row.kind !== 'assistant') throw new PersistenceError('Knowledge evidence may cite only visible conversation messages')
      return
    }
    if (input.sourceType === 'document') {
      const row = this.#database.prepare(
        `SELECT document.workspace_id, document.world_id FROM knowledge_documents AS document
         INNER JOIN knowledge_chunks AS chunk ON chunk.world_id = document.world_id AND chunk.document_id = document.id
         WHERE document.id = ? AND chunk.id = ?`,
      ).get(input.documentId!, input.chunkId!) as Record<string, unknown> | undefined
      if (row === undefined || String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id) throw new PersistenceError('Document evidence is outside this world')
      return
    }
    if (input.sourceType === 'artifact') {
      const row = this.#database.prepare(
        `SELECT workspace_id, world_id FROM world_artifacts WHERE id = ?`,
      ).get(input.artifactId!) as Record<string, unknown> | undefined
      if (row === undefined || String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id) throw new PersistenceError('Artifact evidence is outside this world')
      return
    }
    if (input.createdBy !== 'owner') throw new PersistenceError('Manual knowledge evidence must be created by the owner')
  }

  #evidenceWeight(world: { id: string; workspaceId: string }, input: NormalizedEvidenceInput): number {
    if (input.sourceType !== 'conversation') return evidenceWeight(input.sourceType)
    const row = this.#database.prepare(
      `SELECT messages.sender_kind, messages.kind, sessions.workspace_id, sessions.world_id
       FROM messages INNER JOIN work_sessions AS sessions ON sessions.id = messages.session_id
       WHERE messages.id = ? AND messages.session_id = ? AND messages.sequence = ?`,
    ).get(input.messageId!, input.sessionId!, input.sequence!) as Record<string, unknown> | undefined
    if (row === undefined || String(row.workspace_id) !== world.workspaceId || String(row.world_id) !== world.id) {
      throw new PersistenceError('Conversation evidence is outside this world')
    }
    // Owner-authored user messages are the strongest conversational source;
    // a character's final answer remains useful but is intentionally weaker.
    return row.kind === 'user' && row.sender_kind === 'owner' ? 0.9 : 0.55
  }

  #withTransaction<T>(operation: () => T): T {
    let ownsTransaction = true
    try { this.#database.exec('BEGIN IMMEDIATE') } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
      if (!message.includes('transaction')) throw error
      ownsTransaction = false
    }
    try {
      const result = operation()
      if (ownsTransaction) this.#database.exec('COMMIT')
      return result
    } catch (error) {
      if (ownsTransaction) this.#database.exec('ROLLBACK')
      throw error
    }
  }

  private updateJob(worldId: string, jobId: string, status: KnowledgeConsolidationJob['status'], errorCode?: string): KnowledgeConsolidationJob {
    const current = this.getConsolidationJob(worldId, jobId)
    if (current === undefined) throw new EntityNotFoundError(`Knowledge consolidation job not found: ${jobId}`)
    if (current.status === status) return current
    if (current.status === 'completed' || current.status === 'failed') return current
    const now = this.#clock()
    const completed = status === 'completed' || status === 'failed'
    this.#database.prepare(
      `UPDATE knowledge_consolidation_jobs SET status = ?, error_code = ?, updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END
       WHERE world_id = ? AND id = ?`,
    ).run(status, errorCode ?? null, now, completed ? 1 : 0, completed ? now : null, worldId, jobId)
    return this.getConsolidationJob(worldId, jobId)!
  }

  private setStatementStatus(kind: 'claim' | 'relation', worldId: string, id: string, status: KnowledgeStatementStatus): void {
    this.#database.prepare(`UPDATE knowledge_${kind}s SET status = ?, updated_at = ? WHERE world_id = ? AND id = ?`).run(status, this.#clock(), worldId, id)
  }
}

export class SqliteWorldKnowledgeGraphRepository extends WorldKnowledgeGraphRepository {}

function toEvidenceInput(item: KnowledgeExtractionEvidenceInput, evidenceId: string, createdAt: string): KnowledgeEvidenceInput {
  const base = { id: evidenceId, workspaceId: item.workspaceId, worldId: item.worldId, excerpt: item.excerpt, createdAt }
  if (item.sourceType === 'conversation') {
    if (item.sessionId === undefined || item.messageId === undefined || item.sequence === undefined) throw new PersistenceError('Conversation knowledge evidence is incomplete')
    return { ...base, sourceType: 'conversation', sessionId: item.sessionId, messageId: item.messageId, sequence: item.sequence }
  }
  if (item.sourceType === 'document') {
    if (item.documentId === undefined || item.chunkId === undefined) throw new PersistenceError('Document knowledge evidence is incomplete')
    return { ...base, sourceType: 'document', documentId: item.documentId, chunkId: item.chunkId }
  }
  if (item.sourceType === 'artifact') {
    if (item.artifactId === undefined) throw new PersistenceError('Artifact knowledge evidence is incomplete')
    const artifactVersion = item.artifactVersion === undefined ? undefined : Number(item.artifactVersion)
    if (artifactVersion !== undefined && (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1)) throw new PersistenceError('Artifact knowledge evidence version is invalid')
    return artifactVersion === undefined
      ? { ...base, sourceType: 'artifact', artifactId: item.artifactId }
      : { ...base, sourceType: 'artifact', artifactId: item.artifactId, artifactVersion }
  }
  if (item.createdBy !== 'owner') throw new PersistenceError('Manual knowledge evidence must be created by the owner')
  return { ...base, sourceType: 'manual', createdBy: 'owner' }
}

function evidenceMatchesInput(existing: KnowledgeEvidence, item: KnowledgeExtractionEvidenceInput): boolean {
  if (existing.sourceType !== item.sourceType) return false
  if (existing.workspaceId !== item.workspaceId || existing.worldId !== item.worldId) return false
  if (existing.sourceType === 'conversation' && item.sourceType === 'conversation') return existing.sessionId === item.sessionId && existing.messageId === item.messageId && existing.sequence === item.sequence
  if (existing.sourceType === 'document' && item.sourceType === 'document') return existing.documentId === item.documentId && existing.chunkId === item.chunkId
  if (existing.sourceType === 'artifact' && item.sourceType === 'artifact') {
    const incomingVersion = item.artifactVersion === undefined ? undefined : Number(item.artifactVersion)
    return existing.artifactId === item.artifactId && existing.artifactVersion === incomingVersion
  }
  return true
}

function normalizeEntityInput(input: KnowledgeEntityInput) {
  const canonicalName = input.canonicalName.trim()
  if (!canonicalName) throw new PersistenceError('Knowledge entity name cannot be empty')
  assertEntityType(input.type)
  return {
    id: input.id?.trim() || undefined,
    workspaceId: input.workspaceId.trim(), worldId: input.worldId.trim(), type: input.type,
    canonicalName, aliases: uniqueStrings(input.aliases ?? []), summary: input.summary?.trim() ?? '',
    status: input.status ?? 'active', createdAt: input.createdAt,
  }
}

function normalizeClaimInput(input: KnowledgeClaimInput) {
  const predicate = input.predicate.trim()
  if (!predicate) throw new PersistenceError('Knowledge claim predicate cannot be empty')
  const objectText = input.objectText?.trim() || undefined
  if ((input.objectEntityId === undefined) === (objectText === undefined)) throw new PersistenceError('Knowledge claim needs exactly one object')
  const confidence = input.confidence ?? 0.7
  assertConfidence(confidence)
  const source = input.source ?? 'auto'
  assertStatementSource(source)
  const status = input.status ?? 'active'
  assertStatementStatus(status)
  assertClaimType(input.type)
  return {
    id: input.id?.trim() || undefined, workspaceId: input.workspaceId.trim(), worldId: input.worldId.trim(), type: input.type,
    subjectEntityId: input.subjectEntityId.trim(), predicate, objectEntityId: input.objectEntityId?.trim() || undefined, objectText,
    confidence, status, source, evidenceIds: uniqueStrings(input.evidenceIds ?? []), conflictGroup: input.conflictGroup?.trim() || undefined,
    supersededById: input.supersededById?.trim() || undefined, createdAt: input.createdAt,
  }
}

function normalizeRelationInput(input: KnowledgeRelationInput) {
  const predicate = input.predicate.trim()
  if (!predicate) throw new PersistenceError('Knowledge relation predicate cannot be empty')
  const confidence = input.confidence ?? 0.7
  assertConfidence(confidence)
  const source = input.source ?? 'auto'
  assertStatementSource(source)
  const status = input.status ?? 'active'
  assertStatementStatus(status)
  return {
    id: input.id?.trim() || undefined, workspaceId: input.workspaceId.trim(), worldId: input.worldId.trim(),
    fromEntityId: input.fromEntityId.trim(), toEntityId: input.toEntityId.trim(), predicate, confidence, status, source,
    evidenceIds: uniqueStrings(input.evidenceIds ?? []), conflictGroup: input.conflictGroup?.trim() || undefined,
    supersededById: input.supersededById?.trim() || undefined, createdAt: input.createdAt,
  }
}

function normalizeEvidenceInput(input: KnowledgeEvidenceInput): NormalizedEvidenceInput {
  const excerpt = input.excerpt.trim()
  if (!excerpt) throw new PersistenceError('Knowledge evidence excerpt cannot be empty')
  if (excerpt.length > 4000) throw new PersistenceError('Knowledge evidence excerpt is too long')
  if (input.sourceType === 'conversation') {
    if (!input.sessionId.trim() || !input.messageId.trim()) throw new PersistenceError('Conversation evidence needs a session and message')
    assertSequence(input.sequence)
  } else if (input.sourceType === 'document') {
    if (!input.documentId.trim() || !input.chunkId.trim()) throw new PersistenceError('Document evidence needs a document and chunk')
  } else if (input.sourceType === 'artifact') {
    if (!input.artifactId.trim()) throw new PersistenceError('Artifact evidence needs an artifact')
    if (input.artifactVersion !== undefined && (!Number.isSafeInteger(input.artifactVersion) || input.artifactVersion < 1)) throw new PersistenceError('Artifact evidence version is invalid')
  } else if (input.sourceType === 'manual') {
    if (input.createdBy !== 'owner') throw new PersistenceError('Manual evidence must be created by owner')
  } else throw new PersistenceError('Unknown knowledge evidence source')
  const normalized: NormalizedEvidenceInput = {
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    workspaceId: input.workspaceId.trim(),
    worldId: input.worldId.trim(),
    sourceType: input.sourceType,
    excerpt,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  }
  if (input.sourceType === 'conversation') {
    normalized.sessionId = input.sessionId.trim(); normalized.messageId = input.messageId.trim(); normalized.sequence = input.sequence
  } else if (input.sourceType === 'document') {
    normalized.documentId = input.documentId.trim(); normalized.chunkId = input.chunkId.trim()
  } else if (input.sourceType === 'artifact') {
    normalized.artifactId = input.artifactId.trim(); if (input.artifactVersion !== undefined) normalized.artifactVersion = input.artifactVersion
  } else {
    normalized.createdBy = 'owner'
    const note = input.note?.trim()
    if (note !== undefined && note.length > 4000) throw new PersistenceError('Knowledge evidence note is too long')
    if (note) normalized.note = note
  }
  return normalized
}

function mapEntity(row: unknown): KnowledgeEntity {
  const value = record(row)
  const status = value.status as KnowledgeEntityStatus
  const entity: KnowledgeEntity = {
    id: text(value.id), workspaceId: text(value.workspace_id), worldId: text(value.world_id), type: value.type as KnowledgeEntityType,
    canonicalName: text(value.canonical_name), aliases: parseJson<string[]>(value.aliases_json), summary: text(value.summary), status,
    createdAt: text(value.created_at), updatedAt: text(value.updated_at),
  }
  assertEntityType(entity.type); assertEntityStatus(entity.status)
  if (typeof value.archived_at === 'string') entity.archivedAt = value.archived_at
  return entity
}

function mapClaim(row: unknown): KnowledgeClaim {
  const value = record(row)
  const claim: KnowledgeClaim = {
    id: text(value.id), workspaceId: text(value.workspace_id), worldId: text(value.world_id), type: value.type as KnowledgeClaim['type'],
    subjectEntityId: text(value.subject_entity_id), predicate: text(value.predicate), confidence: Number(value.confidence),
    status: value.status as KnowledgeStatementStatus, source: value.source as KnowledgeStatementSource,
    evidenceIds: parseJson<string[]>(value.evidence_ids_json), createdAt: text(value.created_at), updatedAt: text(value.updated_at),
  }
  if (typeof value.object_entity_id === 'string') claim.objectEntityId = value.object_entity_id
  if (typeof value.object_text === 'string') claim.objectText = value.object_text
  if (typeof value.conflict_group === 'string') claim.conflictGroup = value.conflict_group
  if (typeof value.superseded_by_id === 'string') claim.supersededById = value.superseded_by_id
  return claim
}

function mapRelation(row: unknown): KnowledgeRelation {
  const value = record(row)
  const relation: KnowledgeRelation = {
    id: text(value.id), workspaceId: text(value.workspace_id), worldId: text(value.world_id), fromEntityId: text(value.from_entity_id),
    toEntityId: text(value.to_entity_id), predicate: text(value.predicate), confidence: Number(value.confidence),
    status: value.status as KnowledgeStatementStatus, source: value.source as KnowledgeStatementSource,
    evidenceIds: parseJson<string[]>(value.evidence_ids_json), createdAt: text(value.created_at), updatedAt: text(value.updated_at),
  }
  if (typeof value.conflict_group === 'string') relation.conflictGroup = value.conflict_group
  if (typeof value.superseded_by_id === 'string') relation.supersededById = value.superseded_by_id
  return relation
}

function mapEvidence(row: unknown): KnowledgeEvidence {
  const value = record(row)
  const base = {
    id: text(value.id), workspaceId: text(value.workspace_id), worldId: text(value.world_id), sourceType: String(value.source_type),
    excerpt: text(value.excerpt), sourceWeight: Number(value.source_weight), createdAt: text(value.created_at),
  }
  if (base.sourceType === 'conversation') return { ...base, sourceType: 'conversation', sessionId: text(value.session_id), messageId: text(value.message_id), sequence: Number(value.sequence) } as KnowledgeConversationEvidence
  if (base.sourceType === 'document') return { ...base, sourceType: 'document', documentId: text(value.document_id), chunkId: text(value.chunk_id) } as KnowledgeEvidence
  if (base.sourceType === 'artifact') return { ...base, sourceType: 'artifact', artifactId: text(value.artifact_id), ...(value.artifact_version === null ? {} : { artifactVersion: Number(value.artifact_version) }) } as KnowledgeEvidence
  if (base.sourceType === 'manual') return { ...base, sourceType: 'manual', createdBy: 'owner', ...(typeof value.note === 'string' ? { note: value.note } : {}) } as KnowledgeEvidence
  throw new PersistenceError('Unknown Knowledge evidence source')
}

function mapCursor(row: unknown): KnowledgeConversationCursor {
  const value = record(row)
  return { workspaceId: text(value.workspace_id), worldId: text(value.world_id), sessionId: text(value.session_id), processedThroughSequence: Number(value.processed_through_sequence), updatedAt: text(value.updated_at) }
}

function mapJob(row: unknown): KnowledgeConsolidationJob {
  const value = record(row)
  const job: KnowledgeConsolidationJob = {
    id: text(value.id), workspaceId: text(value.workspace_id), worldId: text(value.world_id), sourceType: value.source_type as KnowledgeConsolidationJob['sourceType'],
    sourceId: text(value.source_id), fromCursor: Number(value.from_cursor), toCursor: Number(value.to_cursor), status: value.status as KnowledgeConsolidationJob['status'], attempt: Number(value.attempt), createdAt: text(value.created_at), updatedAt: text(value.updated_at),
  }
  if (typeof value.error_code === 'string') job.errorCode = value.error_code
  if (typeof value.started_at === 'string') job.startedAt = value.started_at
  if (typeof value.completed_at === 'string') job.completedAt = value.completed_at
  return job
}

function mapSettings(row: unknown): WorldKnowledgeSettings {
  const value = record(row)
  return { workspaceId: text(value.workspace_id), worldId: text(value.world_id), retrievalEnabled: Number(value.retrieval_enabled) === 1, autoConsolidationMode: value.auto_consolidation_mode as WorldKnowledgeSettings['autoConsolidationMode'], ...(typeof value.extraction_model_profile_id === 'string' ? { extractionModelProfileId: value.extraction_model_profile_id } : {}), updatedAt: text(value.updated_at) }
}

function mapSuppression(row: unknown): KnowledgeSuppression {
  const value = record(row)
  return { id: text(value.id), workspaceId: text(value.workspace_id), worldId: text(value.world_id), targetType: value.target_type as KnowledgeSuppressionTarget, fingerprint: text(value.fingerprint), evidenceIds: parseJson<string[]>(value.evidence_ids_json), createdAt: text(value.created_at) }
}

function claimFingerprint(value: Pick<KnowledgeClaim, 'subjectEntityId' | 'predicate' | 'objectEntityId' | 'objectText'>): string {
  return `claim:${value.subjectEntityId}:${value.predicate.toLocaleLowerCase()}:${value.objectEntityId ?? value.objectText?.toLocaleLowerCase() ?? ''}`
}

function relationFingerprint(value: Pick<KnowledgeRelation, 'fromEntityId' | 'toEntityId' | 'predicate'>): string {
  return `relation:${value.fromEntityId}:${value.toEntityId}:${value.predicate.toLocaleLowerCase()}`
}

function evidenceWeight(sourceType: KnowledgeEvidenceSourceType): number {
  return sourceType === 'manual' ? 1 : sourceType === 'conversation' ? 0.9 : sourceType === 'document' ? 0.75 : 0.6
}

function assertEntityType(value: string): asserts value is KnowledgeEntityType {
  if (!['character', 'person', 'place', 'organization', 'project', 'artifact', 'technology', 'concept', 'tool', 'process', 'event', 'topic', 'object', 'other'].includes(value)) throw new PersistenceError(`Unknown Knowledge entity type: ${value}`)
}
function assertClaimType(value: string): void { if (!['fact', 'decision', 'preference', 'rule', 'definition', 'procedure', 'constraint', 'insight', 'lore'].includes(value)) throw new PersistenceError(`Unknown Knowledge claim type: ${value}`) }
function assertEntityStatus(value: string): asserts value is KnowledgeEntityStatus { if (value !== 'active' && value !== 'archived') throw new PersistenceError(`Unknown Knowledge entity status: ${value}`) }
function assertStatementStatus(value: string): asserts value is KnowledgeStatementStatus { if (!['active', 'conflicted', 'superseded', 'archived'].includes(value)) throw new PersistenceError(`Unknown Knowledge statement status: ${value}`) }
function assertStatementSource(value: string): asserts value is KnowledgeStatementSource { if (value !== 'auto' && value !== 'manual') throw new PersistenceError(`Unknown Knowledge statement source: ${value}`) }
function assertSuppressionTarget(value: string): asserts value is KnowledgeSuppressionTarget { if (!['entity', 'claim', 'relation'].includes(value)) throw new PersistenceError(`Unknown Knowledge suppression target: ${value}`) }
function assertEvidenceSourceType(value: string): asserts value is KnowledgeEvidenceSourceType { if (!['conversation', 'document', 'artifact', 'manual'].includes(value)) throw new PersistenceError(`Unknown Knowledge evidence source: ${value}`) }
function normalizeEvidenceSourceType(value: string): KnowledgeEvidenceSourceType { assertEvidenceSourceType(value); return value }
function assertSequence(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new PersistenceError('Knowledge sequence must be a non-negative integer') }
function assertConfidence(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1) throw new PersistenceError('Knowledge confidence must be between 0 and 1') }
function clampLimit(value: number): number { if (!Number.isFinite(value)) throw new PersistenceError('Knowledge graph limit must be finite'); return Math.min(500, Math.max(1, Math.floor(value))) }
function assertNonEmpty(value: string, label: string): void { if (!value.trim()) throw new PersistenceError(`${label} cannot be empty`) }
function uniqueStrings(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))] }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (character) => `\\${character}`) }
function stringifyJson(value: unknown): string { return JSON.stringify(value) }
function parseJson<T>(value: unknown): T { try { return JSON.parse(String(value)) as T } catch { throw new PersistenceError('Knowledge JSON column is invalid') } }
function text(value: unknown): string { if (typeof value !== 'string') throw new PersistenceError('Knowledge text column is invalid'); return value }
function record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null) throw new PersistenceError('Knowledge row is invalid'); return value as Record<string, unknown> }
