import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  KnowledgeChunk,
  KnowledgeChunkInput,
  KnowledgeCollection,
  KnowledgeCollectionInput,
  KnowledgeCollectionOrigin,
  KnowledgeDocument,
  KnowledgeDocumentFilter,
  KnowledgeDocumentInput,
  KnowledgeDocumentOrigin,
  KnowledgeDocumentStatus,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
} from '@dsh-cyber/contracts'

import { EntityNotFoundError, PersistenceError } from './errors.js'

export interface WorldKnowledgeRepositoryOptions {
  clock?: () => string
  idFactory?: () => string
}

export type KnowledgeSearchCapability = 'fts5-trigram' | 'fts5' | 'like'

export interface KnowledgeSearchBackendResult {
  worldId: string
  documentId: string
  chunkId: string
  ordinal: number
  content: string
  score: number
  title?: string
  relativePath?: string
  sourceUrl?: string
  origin?: string
}

export interface ReplaceKnowledgeChunksOptions {
  /** Override the indexing timestamp for deterministic imports/tests. */
  indexedAt?: string
  /** A failed parser may retain a partial projection without claiming it is indexed. */
  status?: Exclude<KnowledgeDocumentStatus, 'missing' | 'pending'>
}

/**
 * SQLite metadata and search projection for the World knowledge library.
 *
 * Source files are deliberately outside this repository. The chunk rows are
 * derived data and replaceChunks() always removes the previous projection in
 * the same transaction before writing the new one, so a scan can rebuild them
 * after a schema/index change without changing source authority.
 */
export class WorldKnowledgeRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #idFactory: () => string
  readonly #fts5Available: boolean
  readonly #fts5Tokenizer: 'trigram' | 'unicode61' | undefined

  constructor(database: DatabaseSync, options: WorldKnowledgeRepositoryOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
    const fts = this.#initializeFts5()
    this.#fts5Available = fts !== undefined
    this.#fts5Tokenizer = fts
  }

  /** The active lexical index; FTS5 is an optional SQLite capability. */
  get searchCapability(): KnowledgeSearchCapability {
    if (!this.#fts5Available) return 'like'
    return this.#fts5Tokenizer === 'trigram' ? 'fts5-trigram' : 'fts5'
  }

  get fts5Available(): boolean {
    return this.#fts5Available
  }

  /** Capability shape consumed by the server's provider-neutral search port. */
  get capabilities(): { fts5: boolean; trigram: boolean; backend: 'fts5-trigram' | 'fts5' | 'portable' } {
    return {
      fts5: this.#fts5Available,
      trigram: this.#fts5Tokenizer === 'trigram',
      backend: !this.#fts5Available ? 'portable' : this.#fts5Tokenizer === 'trigram' ? 'fts5-trigram' : 'fts5',
    }
  }

  getCollection(worldId: string, collectionId: string): KnowledgeCollection | undefined {
    const row = this.#database
      .prepare('SELECT * FROM knowledge_collections WHERE world_id = ? AND id = ?')
      .get(worldId, collectionId)
    return row === undefined ? undefined : mapCollection(row)
  }

  listCollections(worldId: string): KnowledgeCollection[] {
    assertNonEmpty(worldId, 'World id')
    return this.#database
      .prepare(
        `SELECT * FROM knowledge_collections
         WHERE world_id = ?
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(worldId)
      .map(mapCollection)
  }

  createCollection(input: KnowledgeCollectionInput): KnowledgeCollection {
    return this.#withTransaction(() => {
      const world = this.#assertWorld(input.worldId)
      const normalized = normalizeCollectionInput(input)
      const id = normalized.id ?? this.#idFactory()
      const existing = this.#database
        .prepare('SELECT world_id FROM knowledge_collections WHERE id = ?')
        .get(id) as { world_id?: string } | undefined
      if (existing !== undefined && existing.world_id !== world.id) {
        throw new PersistenceError('Knowledge collection id is already owned by another world')
      }
      if (existing !== undefined) throw new PersistenceError(`Knowledge collection already exists: ${id}`)
      const createdAt = normalized.createdAt ?? this.#clock()
      assertTimestamp(createdAt, 'Knowledge collection createdAt')
      this.#database
        .prepare(
          `INSERT INTO knowledge_collections
           (id, world_id, name, description, origin, relative_root, document_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          world.id,
          normalized.name,
          normalized.description ?? null,
          normalized.origin,
          normalized.relativeRoot,
          createdAt,
          createdAt,
        )
      const collection = this.getCollection(world.id, id)
      if (collection === undefined) throw new PersistenceError('Knowledge collection could not be read after insert')
      return collection
    })
  }

  /** Descriptive alias used by import services. */
  saveCollection(input: KnowledgeCollectionInput): KnowledgeCollection {
    if (input.id === undefined) return this.createCollection(input)
    const existing = this.getCollection(input.worldId, input.id)
    if (existing === undefined) return this.createCollection(input)
    const normalized = normalizeCollectionInput(input)
    return this.updateCollection(input.worldId, input.id, {
      name: normalized.name,
      origin: normalized.origin,
      relativeRoot: normalized.relativeRoot,
      ...(normalized.description === undefined ? {} : { description: normalized.description }),
    })
  }

  /** Upsert alias for scan/import services; source files stay outside SQLite. */
  upsertCollection(
    input: KnowledgeCollectionInput & { documentCount?: number; updatedAt?: string },
  ): KnowledgeCollection {
    return this.saveCollection(input)
  }

  updateCollection(
    worldId: string,
    collectionId: string,
    patch: {
      name?: string
      description?: string | null
      origin?: KnowledgeCollectionOrigin
      relativeRoot?: string
    },
  ): KnowledgeCollection {
    const current = this.getCollection(worldId, collectionId)
    if (current === undefined) throw new EntityNotFoundError(`Knowledge collection not found: ${collectionId}`)
    const name = patch.name === undefined ? current.name : patch.name.trim()
    const origin = patch.origin === undefined ? current.origin : patch.origin
    const relativeRoot = patch.relativeRoot === undefined
      ? current.relativeRoot
      : assertRelativePath(patch.relativeRoot, 'Knowledge collection relative root')
    assertNonEmpty(name, 'Knowledge collection name')
    assertCollectionOrigin(origin)
    const updatedAt = this.#clock()
    const description = patch.description === undefined
      ? current.description
      : normalizeOptionalText(patch.description)
    this.#database
      .prepare(
        `UPDATE knowledge_collections
         SET name = ?, description = ?, origin = ?, relative_root = ?, updated_at = ?
         WHERE world_id = ? AND id = ?`,
      )
      .run(name, description ?? null, origin, relativeRoot, updatedAt, worldId, collectionId)
    return this.getCollection(worldId, collectionId)!
  }

  renameCollection(worldId: string, collectionId: string, name: string, description?: string): KnowledgeCollection {
    return this.updateCollection(worldId, collectionId, { name, ...(description === undefined ? {} : { description }) })
  }

  removeCollection(worldId: string, collectionId: string): boolean {
    const result = this.#database
      .prepare('DELETE FROM knowledge_collections WHERE world_id = ? AND id = ?')
      .run(worldId, collectionId)
    return Number(result.changes) === 1
  }

  deleteCollection(worldId: string, collectionId: string): boolean {
    return this.removeCollection(worldId, collectionId)
  }

  getDocument(worldId: string, documentId: string): KnowledgeDocument | undefined {
    const row = this.#database
      .prepare('SELECT * FROM knowledge_documents WHERE world_id = ? AND id = ?')
      .get(worldId, documentId)
    return row === undefined ? undefined : mapDocument(row)
  }

  listDocuments(worldId: string, filter: KnowledgeDocumentFilter = {}): KnowledgeDocument[] {
    assertNonEmpty(worldId, 'World id')
    const clauses = ['world_id = ?']
    const parameters: Array<string | number> = [worldId]
    if (filter.query !== undefined) {
      const query = filter.query.trim()
      if (query) {
        const escaped = escapeLike(query)
        clauses.push('(title LIKE ? ESCAPE \'\\\' OR relative_path LIKE ? ESCAPE \'\\\')')
        parameters.push(`%${escaped}%`, `%${escaped}%`)
      }
    }
    if (filter.collectionId !== undefined) {
      assertNonEmpty(filter.collectionId, 'Knowledge collection id')
      clauses.push('collection_id = ?')
      parameters.push(filter.collectionId.trim())
    }
    if (filter.origin !== undefined) {
      assertDocumentOrigin(filter.origin)
      clauses.push('origin = ?')
      parameters.push(filter.origin)
    }
    if (filter.status !== undefined) {
      assertDocumentStatus(filter.status)
      clauses.push('status = ?')
      parameters.push(filter.status)
    }
    const pageSize = filter.pageSize === undefined ? undefined : clampPageSize(filter.pageSize)
    const page = filter.page === undefined ? 1 : clampPage(filter.page)
    const pagination = pageSize === undefined ? '' : ' LIMIT ? OFFSET ?'
    if (pageSize !== undefined) parameters.push(pageSize, (page - 1) * pageSize)
    return this.#database
      .prepare(
        `SELECT * FROM knowledge_documents
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC, id DESC${pagination}`,
      )
      .all(...parameters)
      .map(mapDocument)
  }

  createDocument(input: KnowledgeDocumentInput): KnowledgeDocument {
    return this.#withTransaction(() => this.#insertDocument(input))
  }

  /**
   * Insert new metadata or update an existing source row. A changed source
   * invalidates its chunks and returns it to pending, preserving projection
   * rebuild semantics for incremental scans.
   */
  saveDocument(input: KnowledgeDocumentInput): KnowledgeDocument {
    return this.#withTransaction(() => {
      const normalized = normalizeDocumentInput(input)
      const existing = normalized.id === undefined
        ? this.#database
          .prepare('SELECT * FROM knowledge_documents WHERE world_id = ? AND relative_path = ?')
          .get(normalized.worldId, normalized.relativePath)
        : this.#database
          .prepare('SELECT * FROM knowledge_documents WHERE world_id = ? AND id = ?')
          .get(normalized.worldId, normalized.id)
      if (existing === undefined) return this.#insertDocument(input)
      const current = mapDocument(existing)
      if (current.workspaceId !== normalized.workspaceId) throw new PersistenceError('Knowledge document workspace scope mismatch')
      if (normalized.collectionId !== undefined) this.#assertCollection(normalized.worldId, normalized.collectionId)
      if (normalized.artifactId !== undefined) this.#assertArtifact(normalized.workspaceId, normalized.worldId, normalized.artifactId)
      const changed = current.relativePath !== normalized.relativePath ||
        current.title !== normalized.title ||
        current.mimeType !== normalized.mimeType ||
        current.byteLength !== normalized.byteLength ||
        current.sha256 !== normalized.sha256 ||
        current.origin !== normalized.origin ||
        (current.sourceUrl ?? undefined) !== normalized.sourceUrl ||
        (current.artifactId ?? undefined) !== normalized.artifactId ||
        (current.collectionId ?? undefined) !== normalized.collectionId
      const now = this.#clock()
      if (changed) {
        this.#database.prepare(
          'DELETE FROM knowledge_chunks WHERE world_id = ? AND document_id = ?',
        ).run(normalized.worldId, current.id)
      }
      const status = changed ? 'pending' : (normalized.status ?? current.status)
      const indexedAt = changed ? null : (current.indexedAt ?? null)
      this.#database
        .prepare(
          `UPDATE knowledge_documents SET
             workspace_id = ?, collection_id = ?, relative_path = ?, title = ?, mime_type = ?,
             byte_length = ?, sha256 = ?, origin = ?, source_url = ?, artifact_id = ?,
             status = ?, chunk_count = ?, updated_at = ?, indexed_at = ?
           WHERE world_id = ? AND id = ?`,
        )
        .run(
          normalized.workspaceId,
          normalized.collectionId ?? null,
          normalized.relativePath,
          normalized.title,
          normalized.mimeType,
          normalized.byteLength,
          normalized.sha256,
          normalized.origin,
          normalized.sourceUrl ?? null,
          normalized.artifactId ?? null,
          status,
          changed ? 0 : current.chunkCount,
          now,
          indexedAt,
          normalized.worldId,
          current.id,
        )
      const document = this.getDocument(normalized.worldId, current.id)
      if (document === undefined) throw new PersistenceError('Knowledge document could not be read after update')
      return document
    })
  }

  upsertDocument(
    input: KnowledgeDocumentInput & { chunkCount?: number; indexedAt?: string; updatedAt?: string },
  ): KnowledgeDocument {
    const document = this.saveDocument(input)
    // Import flows commonly replace chunks first and then upsert the indexed
    // metadata with an explicit timestamp. Preserve that fact without ever
    // trusting a caller-supplied chunk count over the projection itself.
    if (input.indexedAt !== undefined || input.status === 'indexed') {
      const indexedAt = input.indexedAt ?? document.indexedAt ?? this.#clock()
      assertTimestamp(indexedAt, 'Knowledge indexedAt')
      this.#database
        .prepare(
          `UPDATE knowledge_documents
           SET status = 'indexed', indexed_at = ?, updated_at = ?
           WHERE world_id = ? AND id = ?`,
        )
        .run(indexedAt, input.updatedAt ?? this.#clock(), input.worldId, document.id)
      return this.getDocument(input.worldId, document.id)!
    }
    return document
  }

  updateDocumentStatus(worldId: string, documentId: string, status: KnowledgeDocumentStatus): KnowledgeDocument {
    assertDocumentStatus(status)
    const document = this.getDocument(worldId, documentId)
    if (document === undefined) throw new EntityNotFoundError(`Knowledge document not found: ${documentId}`)
    const updatedAt = this.#clock()
    this.#database
      .prepare(
        `UPDATE knowledge_documents SET status = ?, updated_at = ?, indexed_at =
           CASE WHEN ? = 'pending' THEN NULL ELSE indexed_at END
         WHERE world_id = ? AND id = ?`,
      )
      .run(status, updatedAt, status, worldId, documentId)
    return this.getDocument(worldId, documentId)!
  }

  setDocumentStatus(worldId: string, documentId: string, status: KnowledgeDocumentStatus): KnowledgeDocument {
    return this.updateDocumentStatus(worldId, documentId, status)
  }

  markMissing(worldId: string, documentId: string): KnowledgeDocument {
    return this.updateDocumentStatus(worldId, documentId, 'missing')
  }

  removeDocument(worldId: string, documentId: string): boolean {
    const result = this.#database
      .prepare('DELETE FROM knowledge_documents WHERE world_id = ? AND id = ?')
      .run(worldId, documentId)
    return Number(result.changes) === 1
  }

  deleteDocument(worldId: string, documentId: string): boolean {
    return this.removeDocument(worldId, documentId)
  }

  getChunk(worldId: string, chunkId: string): KnowledgeChunk | undefined {
    const row = this.#database
      .prepare('SELECT * FROM knowledge_chunks WHERE world_id = ? AND id = ?')
      .get(worldId, chunkId)
    return row === undefined ? undefined : mapChunk(row)
  }

  /**
   * Reads one bounded window of a document's chunk projection.
   *
   * `listChunks` materializes every chunk of a source, which is fine for a
   * one-off reindex and wrong for a reader: a 2,000,000-character document has
   * thousands of rows and nobody looks at them at once. The window is applied
   * in SQL so a preview costs the size of what is shown, and `total` comes from
   * the same world-scoped statement so a caller can state the range honestly.
   */
  listChunkWindow(
    worldId: string,
    documentId: string,
    window: { offset?: number; limit?: number } = {},
  ): { items: KnowledgeChunk[]; total: number } {
    const document = this.getDocument(worldId, documentId)
    if (document === undefined) return { items: [], total: 0 }
    const offset = boundedWindowValue(window.offset ?? 0, 'Knowledge chunk window offset')
    const limit = boundedWindowValue(window.limit ?? 20, 'Knowledge chunk window limit')
    const totalRow = this.#database
      .prepare('SELECT COUNT(*) AS total FROM knowledge_chunks WHERE world_id = ? AND document_id = ?')
      .get(worldId, document.id)
    const total = integerColumn(record(totalRow, 'knowledge chunk window total'), 'total')
    if (limit === 0 || offset >= total) return { items: [], total }
    const items = this.#database
      .prepare(
        `SELECT * FROM knowledge_chunks
         WHERE world_id = ? AND document_id = ?
         ORDER BY ordinal ASC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(worldId, document.id, limit, offset)
      .map(mapChunk)
    return { items, total }
  }

  listChunks(worldId: string, documentId: string): KnowledgeChunk[]
  listChunks(worldId: string): KnowledgeSearchBackendResult[]
  listChunks(worldId: string, documentId?: string): KnowledgeChunk[] | KnowledgeSearchBackendResult[] {
    if (documentId !== undefined) {
      const document = this.getDocument(worldId, documentId)
      if (document === undefined) return []
      return this.#database
        .prepare(
          `SELECT * FROM knowledge_chunks
           WHERE world_id = ? AND document_id = ?
           ORDER BY ordinal ASC, id ASC`,
        )
        .all(worldId, document.id)
        .map(mapChunk)
    }
    return this.#database
      .prepare(
        `SELECT
           document.world_id, document.id AS document_id, chunk.id AS chunk_id,
           chunk.ordinal, chunk.content, document.title, document.relative_path,
           document.source_url, document.origin
         FROM knowledge_chunks AS chunk
         INNER JOIN knowledge_documents AS document
           ON document.world_id = chunk.world_id AND document.id = chunk.document_id
         WHERE chunk.world_id = ? AND document.status = 'indexed'
         ORDER BY document.updated_at DESC, chunk.ordinal ASC, chunk.id ASC`,
      )
      .all(worldId)
      .map((row) => {
        const value = record(row, 'knowledge search backend result')
        const result: KnowledgeSearchBackendResult = {
          worldId: stringColumn(value, 'world_id'),
          documentId: stringColumn(value, 'document_id'),
          chunkId: stringColumn(value, 'chunk_id'),
          ordinal: integerColumn(value, 'ordinal'),
          content: stringColumn(value, 'content'),
          score: 0,
        }
        if (typeof value.title === 'string') result.title = value.title
        if (typeof value.relative_path === 'string') result.relativePath = value.relative_path
        if (typeof value.source_url === 'string') result.sourceUrl = value.source_url
        if (typeof value.origin === 'string') result.origin = value.origin
        return result
      })
  }

  /** Replace all derived chunks and atomically mark the document indexed. */
  replaceChunks(worldId: string, documentId: string, chunks: readonly KnowledgeChunkInput[], options?: ReplaceKnowledgeChunksOptions | string): KnowledgeChunk[]
  replaceChunks(input: { worldId: string; documentId: string; chunks: readonly KnowledgeChunkInput[] }): void
  replaceChunks(
    worldIdOrInput: string | { worldId: string; documentId: string; chunks: readonly KnowledgeChunkInput[] },
    documentIdOrUndefined?: string,
    chunksOrUndefined?: readonly KnowledgeChunkInput[],
    options: ReplaceKnowledgeChunksOptions | string = {},
  ): KnowledgeChunk[] | void {
    if (typeof worldIdOrInput !== 'string') {
      this.replaceChunks(worldIdOrInput.worldId, worldIdOrInput.documentId, worldIdOrInput.chunks)
      return
    }
    const worldId = worldIdOrInput
    const documentId = documentIdOrUndefined
    if (documentId === undefined || chunksOrUndefined === undefined) {
      throw new PersistenceError('Knowledge chunk replacement requires a world, document, and chunks')
    }
    return this.#withTransaction(() => {
      const document = this.getDocument(worldId, documentId)
      if (document === undefined) throw new EntityNotFoundError(`Knowledge document not found: ${documentId}`)
      const replacement = normalizeChunks(worldId, documentId, chunksOrUndefined, this.#clock, this.#idFactory)
      const resolvedOptions: ReplaceKnowledgeChunksOptions = typeof options === 'string'
        ? { indexedAt: options }
        : options
      const indexedAt = resolvedOptions.indexedAt ?? this.#clock()
      assertTimestamp(indexedAt, 'Knowledge indexedAt')
      const status = resolvedOptions.status ?? 'indexed'
      if (status !== 'indexed' && status !== 'failed') {
        throw new PersistenceError('Replacing knowledge chunks can only produce indexed or failed status')
      }
      this.#database
        .prepare('DELETE FROM knowledge_chunks WHERE world_id = ? AND document_id = ?')
        .run(worldId, documentId)
      const insert = this.#database.prepare(
        `INSERT INTO knowledge_chunks
         (id, world_id, document_id, ordinal, content, content_hash, start_offset, end_offset, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const chunk of replacement) {
        insert.run(
          chunk.id,
          worldId,
          documentId,
          chunk.ordinal,
          chunk.content,
          chunk.contentHash,
          chunk.startOffset ?? null,
          chunk.endOffset ?? null,
          chunk.createdAt,
        )
      }
      this.#database
        .prepare(
          `UPDATE knowledge_documents
           SET chunk_count = ?, status = ?, indexed_at = ?, updated_at = ?
           WHERE world_id = ? AND id = ?`,
        )
        .run(replacement.length, status, indexedAt, this.#clock(), worldId, documentId)
      return this.listChunks(worldId, documentId)
    })
  }

  replaceDocumentChunks(
    worldId: string,
    documentId: string,
    chunks: readonly KnowledgeChunkInput[],
    options: ReplaceKnowledgeChunksOptions | string = {},
  ): KnowledgeChunk[] {
    return this.replaceChunks(worldId, documentId, chunks, options)
  }

  clearChunks(worldId: string, documentId: string, indexedAt?: string): KnowledgeChunk[] {
    return this.replaceChunks(worldId, documentId, [], indexedAt ?? {})
  }

  /** Reconcile denormalized counts after a direct restore or manual repair. */
  rebuildProjection(worldId: string): void {
    this.#assertWorld(worldId)
    this.#withTransaction(() => {
      this.#database
        .prepare(
          `UPDATE knowledge_documents AS document
           SET chunk_count = (
             SELECT COUNT(*) FROM knowledge_chunks AS chunk
             WHERE chunk.world_id = document.world_id AND chunk.document_id = document.id
           )
           WHERE document.world_id = ?`,
        )
        .run(worldId)
      this.#database
        .prepare(
          `UPDATE knowledge_collections AS collection
           SET document_count = (
             SELECT COUNT(*) FROM knowledge_documents AS document
             WHERE document.world_id = collection.world_id
               AND document.collection_id = collection.id
           )
           WHERE collection.world_id = ?`,
        )
        .run(worldId)
    })
  }

  rebuildCounts(worldId: string): void {
    this.rebuildProjection(worldId)
  }

  /**
   * Portable fallback search. It intentionally uses ordinary SQLite LIKE so
   * FTS5 is an optional optimization rather than a migration-time dependency.
   */
  search(input: KnowledgeSearchInput): KnowledgeSearchResult[]
  search(worldId: string, query: string, limit?: number): KnowledgeSearchResult[]
  search(
    inputOrWorldId: KnowledgeSearchInput | string,
    queryArgument?: string,
    limitArgument?: number,
  ): KnowledgeSearchResult[] {
    const input: KnowledgeSearchInput = typeof inputOrWorldId === 'string'
      ? { worldId: inputOrWorldId, query: queryArgument ?? '', limit: limitArgument ?? 20 }
      : inputOrWorldId
    assertNonEmpty(input.worldId, 'World id')
    const query = input.query.trim()
    if (!query) return []
    if (query.length > 500) throw new PersistenceError('Knowledge search query is too long')
    const terms = lexicalSearchTerms(query)
    if (terms.length === 0) return []
    const limit = clampSearchLimit(input.limit)
    if (this.#fts5Available) {
      try {
        const indexed = this.#searchFts5(input.worldId, terms, limit)
        if (indexed.length > 0) return indexed
      } catch {
        // A SQLite build can expose FTS5 but reject a tokenizer/query syntax.
        // Keep the portable, world-scoped SQL fallback available.
      }
    }
    const termClause = terms.map(() => `(chunk.content LIKE ? ESCAPE '\\' OR document.title LIKE ? ESCAPE '\\' OR document.relative_path LIKE ? ESCAPE '\\')`).join(' OR ')
    const termParameters = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`
      return [pattern, pattern, pattern]
    })
    const rows = this.#database
      .prepare(
        `SELECT
           document.world_id, document.id AS document_id, chunk.id AS chunk_id,
           document.collection_id, document.title, document.relative_path,
           chunk.ordinal, chunk.content
         FROM knowledge_chunks AS chunk
         INNER JOIN knowledge_documents AS document
           ON document.world_id = chunk.world_id AND document.id = chunk.document_id
         WHERE chunk.world_id = ?
           AND document.status = 'indexed'
           AND (${termClause})
         ORDER BY
           document.updated_at DESC, chunk.ordinal ASC, chunk.id ASC
         LIMIT ?`,
      )
      .all(
        input.worldId,
        ...termParameters,
        limit,
      )
    return rows.map((row) => {
      const value = record(row, 'knowledge search result')
      const result: KnowledgeSearchResult = {
        worldId: stringColumn(value, 'world_id'),
        documentId: stringColumn(value, 'document_id'),
        chunkId: stringColumn(value, 'chunk_id'),
        title: stringColumn(value, 'title'),
        relativePath: stringColumn(value, 'relative_path'),
        ordinal: integerColumn(value, 'ordinal'),
        content: stringColumn(value, 'content'),
        score: 1,
      }
      if (typeof value.collection_id === 'string') result.collectionId = value.collection_id
      return result
    })
  }

  /** Indexed backend seam used by the server search port. */
  searchIndexed(input: { worldId: string; query: string; limit?: number; maxChars?: number }): KnowledgeSearchBackendResult[] {
    const results = this.search(input.worldId, input.query, input.limit ?? 20)
    const maxChars = input.maxChars === undefined ? undefined : Math.max(0, Math.floor(input.maxChars))
    let chars = 0
    return results.flatMap((result) => {
      if (maxChars !== undefined && chars >= maxChars) return []
      const content = maxChars === undefined ? result.content : result.content.slice(0, Math.max(0, maxChars - chars))
      if (!content) return []
      chars += content.length
      return [{ ...result, content }]
    })
  }

  #initializeFts5(): 'trigram' | 'unicode61' | undefined {
    try {
      const existing = this.#database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_fts'")
        .get() as { sql?: unknown } | undefined
      let tokenizer: 'trigram' | 'unicode61' = existing?.sql && String(existing.sql).includes('trigram')
        ? 'trigram'
        : 'unicode61'
      if (existing === undefined) {
        try {
          this.#database.exec(
            `CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
               chunk_id UNINDEXED,
               world_id UNINDEXED,
               document_id UNINDEXED,
               content,
               tokenize = 'trigram'
             )`,
          )
          tokenizer = 'trigram'
        } catch {
          this.#database.exec(
            `CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
               chunk_id UNINDEXED,
               world_id UNINDEXED,
               document_id UNINDEXED,
               content,
               tokenize = 'unicode61'
             )`,
          )
          tokenizer = 'unicode61'
        }
      }
      this.#database.exec(
        `CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_insert
         AFTER INSERT ON knowledge_chunks
         BEGIN
           INSERT INTO knowledge_chunks_fts (chunk_id, world_id, document_id, content)
           VALUES (NEW.id, NEW.world_id, NEW.document_id, NEW.content);
         END;
         CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_delete
         AFTER DELETE ON knowledge_chunks
         BEGIN
           DELETE FROM knowledge_chunks_fts WHERE chunk_id = OLD.id;
         END;
         CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_update
         AFTER UPDATE OF world_id, document_id, content ON knowledge_chunks
         BEGIN
           DELETE FROM knowledge_chunks_fts WHERE chunk_id = OLD.id;
           INSERT INTO knowledge_chunks_fts (chunk_id, world_id, document_id, content)
           VALUES (NEW.id, NEW.world_id, NEW.document_id, NEW.content);
         END;`,
      )
      // Rebuild from the source projection so a derived FTS table can always
      // be discarded and recreated after restore or index upgrades.
      this.#database.exec(
        `DELETE FROM knowledge_chunks_fts;
         INSERT INTO knowledge_chunks_fts (chunk_id, world_id, document_id, content)
         SELECT id, world_id, document_id, content FROM knowledge_chunks;`,
      )
      return tokenizer
    } catch {
      return undefined
    }
  }

  #searchFts5(worldId: string, terms: readonly string[], limit: number): KnowledgeSearchResult[] {
    // Each lexical term is quoted independently so user text can never become
    // an FTS operator. OR semantics make natural-language Chinese prompts
    // useful without a second model call or an in-memory full scan.
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
    const rows = this.#database
      .prepare(
        `SELECT
           document.world_id, document.id AS document_id, chunk.id AS chunk_id,
           document.collection_id, document.title, document.relative_path,
           chunk.ordinal, chunk.content, knowledge_chunks_fts.rank AS rank
         FROM knowledge_chunks_fts
         INNER JOIN knowledge_chunks AS chunk
           ON chunk.id = knowledge_chunks_fts.chunk_id AND chunk.world_id = knowledge_chunks_fts.world_id
         INNER JOIN knowledge_documents AS document
           ON document.world_id = chunk.world_id AND document.id = chunk.document_id
         WHERE knowledge_chunks_fts MATCH ?
           AND document.world_id = ?
           AND document.status = 'indexed'
         ORDER BY knowledge_chunks_fts.rank ASC, document.updated_at DESC,
           chunk.ordinal ASC, chunk.id ASC
         LIMIT ?`,
      )
      .all(match, worldId, limit)
    return rows.map((row) => {
      const value = record(row, 'knowledge FTS result')
      const rank = Number(value.rank)
      const result: KnowledgeSearchResult = {
        worldId: stringColumn(value, 'world_id'),
        documentId: stringColumn(value, 'document_id'),
        chunkId: stringColumn(value, 'chunk_id'),
        title: stringColumn(value, 'title'),
        relativePath: stringColumn(value, 'relative_path'),
        ordinal: integerColumn(value, 'ordinal'),
        content: stringColumn(value, 'content'),
        score: Number.isFinite(rank) ? Math.max(0, -rank) : 1,
      }
      if (typeof value.collection_id === 'string') result.collectionId = value.collection_id
      return result
    })
  }

  #insertDocument(input: KnowledgeDocumentInput): KnowledgeDocument {
    const world = this.#assertWorld(input.worldId)
    const normalized = normalizeDocumentInput(input)
    if (normalized.workspaceId !== world.workspaceId) throw new PersistenceError('Knowledge document workspace scope mismatch')
    if (normalized.collectionId !== undefined) this.#assertCollection(world.id, normalized.collectionId)
    if (normalized.artifactId !== undefined) this.#assertArtifact(world.workspaceId, world.id, normalized.artifactId)
    const id = normalized.id ?? this.#idFactory()
    const existing = this.#database
      .prepare('SELECT world_id FROM knowledge_documents WHERE id = ?')
      .get(id) as { world_id?: string } | undefined
    if (existing !== undefined && existing.world_id !== world.id) {
      throw new PersistenceError('Knowledge document id is already owned by another world')
    }
    if (existing !== undefined) throw new PersistenceError(`Knowledge document already exists: ${id}`)
    const createdAt = normalized.createdAt ?? this.#clock()
    assertTimestamp(createdAt, 'Knowledge document createdAt')
    this.#database
      .prepare(
        `INSERT INTO knowledge_documents
         (id, workspace_id, world_id, collection_id, relative_path, title, mime_type,
          byte_length, sha256, origin, source_url, artifact_id, status, chunk_count,
          created_at, updated_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      )
      .run(
        id,
        world.workspaceId,
        world.id,
        normalized.collectionId ?? null,
        normalized.relativePath,
        normalized.title,
        normalized.mimeType,
        normalized.byteLength,
        normalized.sha256,
        normalized.origin,
        normalized.sourceUrl ?? null,
        normalized.artifactId ?? null,
        normalized.status ?? 'pending',
        createdAt,
        createdAt,
      )
    const document = this.getDocument(world.id, id)
    if (document === undefined) throw new PersistenceError('Knowledge document could not be read after insert')
    return document
  }

  #assertWorld(worldId: string): { id: string; workspaceId: string } {
    assertNonEmpty(worldId, 'World id')
    const row = this.#database
      .prepare('SELECT id, workspace_id FROM worlds WHERE id = ?')
      .get(worldId) as { id?: string; workspace_id?: string } | undefined
    if (row === undefined) throw new EntityNotFoundError(`World not found: ${worldId}`)
    return { id: String(row.id), workspaceId: String(row.workspace_id) }
  }

  #assertCollection(worldId: string, collectionId: string): void {
    assertNonEmpty(collectionId, 'Knowledge collection id')
    if (this.getCollection(worldId, collectionId) === undefined) {
      throw new EntityNotFoundError(`Knowledge collection not found: ${collectionId}`)
    }
  }

  #assertArtifact(workspaceId: string, worldId: string, artifactId: string): void {
    const row = this.#database
      .prepare('SELECT workspace_id, world_id FROM world_artifacts WHERE id = ?')
      .get(artifactId) as { workspace_id?: string; world_id?: string } | undefined
    if (row === undefined || row.workspace_id !== workspaceId || row.world_id !== worldId) {
      throw new PersistenceError('Knowledge artifact provenance is outside this world')
    }
  }

  #withTransaction<T>(operation: () => T): T {
    let ownsTransaction = true
    try {
      this.#database.exec('BEGIN IMMEDIATE')
    } catch (error) {
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
}

/** Descriptive alias for dependency-injection sites. */
export class SqliteWorldKnowledgeRepository extends WorldKnowledgeRepository {}

interface NormalizedCollectionInput {
  id?: string
  worldId: string
  name: string
  description?: string
  origin: KnowledgeCollectionOrigin
  relativeRoot: string
  createdAt?: string
}

interface NormalizedDocumentInput {
  id?: string
  workspaceId: string
  worldId: string
  collectionId?: string
  relativePath: string
  title: string
  mimeType: string
  byteLength: number
  sha256: string
  origin: KnowledgeDocumentOrigin
  sourceUrl?: string
  artifactId?: string
  status?: KnowledgeDocumentStatus
  createdAt?: string
}

function normalizeCollectionInput(input: KnowledgeCollectionInput): NormalizedCollectionInput {
  const name = input.name.trim()
  const worldId = input.worldId.trim()
  assertNonEmpty(name, 'Knowledge collection name')
  assertNonEmpty(worldId, 'World id')
  assertCollectionOrigin(input.origin)
  const id = input.id?.trim() || undefined
  if (id !== undefined) assertNonEmpty(id, 'Knowledge collection id')
  const normalized: NormalizedCollectionInput = {
    worldId,
    name,
    origin: input.origin,
    relativeRoot: assertRelativePath(input.relativeRoot, 'Knowledge collection relative root', true),
  }
  if (id !== undefined) normalized.id = id
  const description = normalizeOptionalText(input.description)
  if (description !== undefined) normalized.description = description
  if (input.createdAt !== undefined) normalized.createdAt = input.createdAt
  return normalized
}

function normalizeDocumentInput(input: KnowledgeDocumentInput): NormalizedDocumentInput {
  const workspaceId = input.workspaceId.trim()
  const worldId = input.worldId.trim()
  const title = input.title.trim()
  const mimeType = input.mimeType.trim()
  assertNonEmpty(workspaceId, 'Workspace id')
  assertNonEmpty(worldId, 'World id')
  assertNonEmpty(title, 'Knowledge document title')
  assertNonEmpty(mimeType, 'Knowledge document mime type')
  assertDocumentOrigin(input.origin)
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new PersistenceError('Knowledge document byte length must be a non-negative integer')
  }
  const sha256 = input.sha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new PersistenceError('Knowledge document sha256 must be a 64-character hexadecimal digest')
  const id = input.id?.trim() || undefined
  if (id !== undefined) assertNonEmpty(id, 'Knowledge document id')
  const collectionId = input.collectionId?.trim() || undefined
  const artifactId = input.artifactId?.trim() || undefined
  const sourceUrl = normalizeOptionalText(input.sourceUrl)
  const normalized: NormalizedDocumentInput = {
    workspaceId,
    worldId,
    relativePath: assertRelativePath(input.relativePath, 'Knowledge document relative path'),
    title,
    mimeType,
    byteLength: input.byteLength,
    sha256,
    origin: input.origin,
  }
  if (id !== undefined) normalized.id = id
  if (collectionId !== undefined) normalized.collectionId = collectionId
  if (sourceUrl !== undefined) normalized.sourceUrl = sourceUrl
  if (artifactId !== undefined) normalized.artifactId = artifactId
  if (input.status !== undefined) {
    assertDocumentStatus(input.status)
    normalized.status = input.status
  }
  if (input.createdAt !== undefined) normalized.createdAt = input.createdAt
  return normalized
}

function normalizeChunks(
  worldId: string,
  documentId: string,
  chunks: readonly KnowledgeChunkInput[],
  clock: () => string,
  idFactory: () => string,
): KnowledgeChunk[] {
  const seenOrdinals = new Set<number>()
  const seenIds = new Set<string>()
  return chunks.map((input) => {
    if (input.worldId !== undefined && input.worldId.trim() !== worldId) {
      throw new PersistenceError('Knowledge chunk world scope mismatch')
    }
    if (input.documentId !== undefined && input.documentId.trim() !== documentId) {
      throw new PersistenceError('Knowledge chunk document scope mismatch')
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || seenOrdinals.has(input.ordinal)) {
      throw new PersistenceError('Knowledge chunk ordinal must be a unique non-negative integer')
    }
    seenOrdinals.add(input.ordinal)
    const id = input.id?.trim() || idFactory()
    assertNonEmpty(id, 'Knowledge chunk id')
    if (seenIds.has(id)) throw new PersistenceError('Knowledge chunk ids must be unique')
    seenIds.add(id)
    if (!input.content) throw new PersistenceError('Knowledge chunk content cannot be empty')
    const contentHash = input.contentHash.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new PersistenceError('Knowledge chunk contentHash must be a 64-character hexadecimal digest')
    assertOffset(input.startOffset, 'Knowledge chunk startOffset')
    assertOffset(input.endOffset, 'Knowledge chunk endOffset')
    if (input.startOffset !== undefined && input.endOffset !== undefined && input.endOffset < input.startOffset) {
      throw new PersistenceError('Knowledge chunk endOffset must be >= startOffset')
    }
    const createdAt = input.createdAt ?? clock()
    assertTimestamp(createdAt, 'Knowledge chunk createdAt')
    return {
      id,
      worldId,
      documentId,
      ordinal: input.ordinal,
      content: input.content,
      contentHash,
      ...(input.startOffset === undefined ? {} : { startOffset: input.startOffset }),
      ...(input.endOffset === undefined ? {} : { endOffset: input.endOffset }),
      createdAt,
    }
  })
}

function mapCollection(row: unknown): KnowledgeCollection {
  const value = record(row, 'knowledge collection')
  const collection: KnowledgeCollection = {
    id: stringColumn(value, 'id'),
    worldId: stringColumn(value, 'world_id'),
    name: stringColumn(value, 'name'),
    origin: value.origin as KnowledgeCollectionOrigin,
    relativeRoot: stringColumn(value, 'relative_root'),
    documentCount: integerColumn(value, 'document_count'),
    createdAt: stringColumn(value, 'created_at'),
    updatedAt: stringColumn(value, 'updated_at'),
  }
  assertCollectionOrigin(collection.origin)
  if (typeof value.description === 'string') collection.description = value.description
  return collection
}

function mapDocument(row: unknown): KnowledgeDocument {
  const value = record(row, 'knowledge document')
  const document: KnowledgeDocument = {
    id: stringColumn(value, 'id'),
    workspaceId: stringColumn(value, 'workspace_id'),
    worldId: stringColumn(value, 'world_id'),
    relativePath: stringColumn(value, 'relative_path'),
    title: stringColumn(value, 'title'),
    mimeType: stringColumn(value, 'mime_type'),
    byteLength: integerColumn(value, 'byte_length'),
    sha256: stringColumn(value, 'sha256'),
    origin: value.origin as KnowledgeDocumentOrigin,
    status: value.status as KnowledgeDocumentStatus,
    chunkCount: integerColumn(value, 'chunk_count'),
    createdAt: stringColumn(value, 'created_at'),
    updatedAt: stringColumn(value, 'updated_at'),
  }
  assertDocumentOrigin(document.origin)
  assertDocumentStatus(document.status)
  if (typeof value.collection_id === 'string') document.collectionId = value.collection_id
  if (typeof value.source_url === 'string') document.sourceUrl = value.source_url
  if (typeof value.artifact_id === 'string') document.artifactId = value.artifact_id
  if (typeof value.indexed_at === 'string') document.indexedAt = value.indexed_at
  return document
}

function mapChunk(row: unknown): KnowledgeChunk {
  const value = record(row, 'knowledge chunk')
  const chunk: KnowledgeChunk = {
    id: stringColumn(value, 'id'),
    worldId: stringColumn(value, 'world_id'),
    documentId: stringColumn(value, 'document_id'),
    ordinal: integerColumn(value, 'ordinal'),
    content: stringColumn(value, 'content'),
    contentHash: stringColumn(value, 'content_hash'),
    createdAt: stringColumn(value, 'created_at'),
  }
  if (value.start_offset !== null && value.start_offset !== undefined) chunk.startOffset = integerColumn(value, 'start_offset')
  if (value.end_offset !== null && value.end_offset !== undefined) chunk.endOffset = integerColumn(value, 'end_offset')
  return chunk
}

function assertCollectionOrigin(value: string): asserts value is KnowledgeCollectionOrigin {
  if (!['folder', 'zip', 'manual', 'web', 'artifact'].includes(value)) {
    throw new PersistenceError(`Unknown Knowledge collection origin: ${value}`)
  }
}

function assertDocumentOrigin(value: string): asserts value is KnowledgeDocumentOrigin {
  if (!['upload', 'paste', 'web', 'filesystem', 'artifact'].includes(value)) {
    throw new PersistenceError(`Unknown Knowledge document origin: ${value}`)
  }
}

function assertDocumentStatus(value: string): asserts value is KnowledgeDocumentStatus {
  if (!['pending', 'indexed', 'failed', 'missing'].includes(value)) {
    throw new PersistenceError(`Unknown Knowledge document status: ${value}`)
  }
}

function assertOffset(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new PersistenceError(`${label} must be a non-negative integer`)
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new PersistenceError(`${label} must be a valid ISO timestamp`)
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new PersistenceError(`${label} cannot be empty`)
}

function assertRelativePath(value: string, label: string, allowEmpty = false): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (allowEmpty && normalized.length === 0) return ''
  assertNonEmpty(normalized, label)
  if (normalized.includes('\0') || /[\u0001-\u001f\u007f]/.test(normalized) || /%(?:2f|2e|5c)/i.test(normalized) || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new PersistenceError(`${label} must be relative to the knowledge library`)
  }
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || /[:*?"<>|]/.test(segment) || /[ .]$/.test(segment) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(segment))) {
    throw new PersistenceError(`${label} contains an unsafe path segment`)
  }
  return normalized
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function lexicalSearchTerms(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase()
  const terms: string[] = []
  const seen = new Set<string>()
  const push = (term: string) => {
    const clean = term.trim()
    if (clean.length < 2 || seen.has(clean)) return
    seen.add(clean)
    terms.push(clean)
  }
  for (const token of normalized.match(/[a-z0-9][a-z0-9._-]{1,63}/g) ?? []) push(token)
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (sequence.length <= 6) push(sequence)
    const width = sequence.length === 2 ? 2 : 3
    for (let index = 0; index <= sequence.length - width && terms.length < 20; index += 1) push(sequence.slice(index, index + width))
  }
  return terms.slice(0, 20)
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) throw new PersistenceError('Knowledge page size must be finite')
  return Math.min(100, Math.max(1, Math.floor(value)))
}

function clampPage(value: number): number {
  if (!Number.isFinite(value)) throw new PersistenceError('Knowledge page must be finite')
  return Math.max(1, Math.floor(value))
}

function clampSearchLimit(value: number): number {
  if (!Number.isFinite(value)) throw new PersistenceError('Knowledge search limit must be finite')
  return Math.min(100, Math.max(1, Math.floor(value)))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new PersistenceError(`Invalid ${label} row`)
  return value as Record<string, unknown>
}

function stringColumn(value: Record<string, unknown>, key: string): string {
  const entry = value[key]
  if (typeof entry !== 'string') throw new PersistenceError(`Invalid Knowledge column: ${key}`)
  return entry
}

function boundedWindowValue(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new PersistenceError(`${label} must be a non-negative integer`)
  return value
}

function integerColumn(value: Record<string, unknown>, key: string): number {
  const entry = Number(value[key])
  if (!Number.isSafeInteger(entry)) throw new PersistenceError(`Invalid Knowledge integer column: ${key}`)
  return entry
}
