import type { DatabaseSync } from 'node:sqlite'

import type {
  EmployeeMemoryIndexEntry,
  EmployeeMemoryIndexHit,
  EmployeeMemoryScope,
} from '@dsh-cyber/contracts'

import { PersistenceError } from './errors.js'

export type MemoryIndexSearchCapability = 'fts5' | 'like'

export interface UpsertEmployeeMemoryIndexEntryInput {
  /** The durable milestone id. The index never mints its own identity. */
  memoryId: string
  scope: EmployeeMemoryScope
  keywords?: readonly string[]
  entities?: readonly string[]
  /** Retrieval prior in [0, 1]. Defaults to a neutral 0.5. */
  importance?: number
  /** Overrides the projected summary; defaults to the milestone summary. */
  summary?: string
  updatedAt?: string
}

export interface SearchEmployeeMemoryIndexInput {
  employeeId: string
  query: string
  /**
   * Required on purpose. A group turn must pass ['group','task'] and can never
   * reach a private memory by forgetting an argument.
   */
  scopes: readonly EmployeeMemoryScope[]
  limit?: number
}

export interface EmployeeMemoryIndexRepositoryOptions {
  clock?: () => string
  readOnly?: boolean
}

const FTS_TABLE_SQL = (tokenizer: 'trigram' | 'unicode61'): string =>
  `CREATE VIRTUAL TABLE employee_memory_index_fts USING fts5(
     memory_id UNINDEXED,
     employee_id UNINDEXED,
     scope UNINDEXED,
     content,
     tokenize = '${tokenizer}'
   )`

const MAX_SEARCH_LIMIT = 50
/**
 * Hard upper bound on a retrieval query.
 *
 * A caller turning a model prompt into a query has to respect it: a runtime
 * prompt can legitimately grow past it (a skill continuation carries an action
 * report), and the repository rejects rather than silently truncating.
 */
export const MAX_MEMORY_INDEX_QUERY_CHARS = 500
const MAX_TERMS = 24

/**
 * SQLite + FTS5 retrieval index over durable employee milestones.
 *
 * The index is derived data. `memoryId` is the milestone id, so an entry can
 * always relocate its source messages and artifacts, and the whole table can
 * be deleted and rebuilt from `employee_milestones` without losing a fact.
 * There is no vector store and no network dependency: FTS5 is an optional
 * SQLite capability and the portable LIKE path stays the contract.
 */
export class EmployeeMemoryIndexRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #readOnly: boolean
  readonly #fts5: boolean

  constructor(database: DatabaseSync, options: EmployeeMemoryIndexRepositoryOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#readOnly = options.readOnly ?? false
    this.#fts5 = this.#initializeFts5()
  }

  get searchCapability(): MemoryIndexSearchCapability {
    return this.#fts5 ? 'fts5' : 'like'
  }

  upsert(input: UpsertEmployeeMemoryIndexEntryInput): EmployeeMemoryIndexEntry {
    const milestone = this.#database
      .prepare(
        `SELECT workspace_id, world_id, employee_id, summary,
                source_message_ids_json, artifact_refs_json, occurred_at
         FROM employee_milestones WHERE id = ?`,
      )
      .get(input.memoryId) as Record<string, unknown> | undefined
    if (milestone === undefined) {
      throw new PersistenceError(`Memory index requires a durable milestone: ${input.memoryId}`)
    }
    const summary = (input.summary ?? String(milestone.summary)).trim()
    if (!summary) throw new PersistenceError('Memory index summary cannot be empty')
    const entry: EmployeeMemoryIndexEntry = {
      memoryId: input.memoryId,
      workspaceId: String(milestone.workspace_id),
      worldId: String(milestone.world_id),
      employeeId: String(milestone.employee_id),
      scope: input.scope,
      summary,
      keywords: normalizeTerms(input.keywords ?? []),
      entities: normalizeTerms(input.entities ?? []),
      sourceMessageIds: parseStrings(milestone.source_message_ids_json),
      artifactRefs: parseStrings(milestone.artifact_refs_json),
      importance: clampImportance(input.importance),
      occurredAt: String(milestone.occurred_at),
      updatedAt: input.updatedAt ?? this.#clock(),
    }
    this.#database
      .prepare(
        `INSERT INTO employee_memory_index (
           memory_id, workspace_id, world_id, employee_id, scope, summary,
           keywords_json, entities_json, source_message_ids_json, artifact_refs_json,
           importance, occurred_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           scope = excluded.scope,
           summary = excluded.summary,
           keywords_json = excluded.keywords_json,
           entities_json = excluded.entities_json,
           source_message_ids_json = excluded.source_message_ids_json,
           artifact_refs_json = excluded.artifact_refs_json,
           importance = excluded.importance,
           occurred_at = excluded.occurred_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.memoryId,
        entry.workspaceId,
        entry.worldId,
        entry.employeeId,
        entry.scope,
        entry.summary,
        JSON.stringify(entry.keywords),
        JSON.stringify(entry.entities),
        JSON.stringify(entry.sourceMessageIds),
        JSON.stringify(entry.artifactRefs),
        entry.importance,
        entry.occurredAt,
        entry.updatedAt,
      )
    this.#syncFts(entry)
    return entry
  }

  get(memoryId: string): EmployeeMemoryIndexEntry | undefined {
    const row = this.#database
      .prepare('SELECT * FROM employee_memory_index WHERE memory_id = ?')
      .get(memoryId)
    return row === undefined ? undefined : mapEntry(row)
  }

  list(employeeId: string, scopes: readonly EmployeeMemoryScope[], limit = 100): EmployeeMemoryIndexEntry[] {
    const visible = normalizeScopes(scopes)
    if (visible.length === 0) return []
    return this.#database
      .prepare(
        `SELECT * FROM employee_memory_index
         WHERE employee_id = ? AND scope IN (${visible.map(() => '?').join(', ')})
         ORDER BY occurred_at DESC, memory_id LIMIT ?`,
      )
      .all(employeeId, ...visible, Math.max(1, Math.min(limit, 500)))
      .map(mapEntry)
  }

  /**
   * Keyword / entity / recency / importance ranking.
   *
   * FTS5 narrows the candidate set when the SQLite build has it; the score is
   * always computed here so ranking is identical on a portable build.
   */
  search(input: SearchEmployeeMemoryIndexInput): EmployeeMemoryIndexHit[] {
    const visible = normalizeScopes(input.scopes)
    if (visible.length === 0) return []
    const query = input.query.trim()
    if (!query) return []
    if (query.length > MAX_MEMORY_INDEX_QUERY_CHARS) throw new PersistenceError('Memory index query is too long')
    const terms = searchTerms(query)
    const limit = Math.max(1, Math.min(input.limit ?? 8, MAX_SEARCH_LIMIT))

    const candidates = terms.length === 0
      ? []
      : this.#candidates(input.employeeId, visible, terms)
    // Recency and importance still matter when nothing matched lexically:
    // a character asked "还记得吗" should not lose all continuity.
    const pool = candidates.length > 0 ? candidates : this.list(input.employeeId, visible, MAX_SEARCH_LIMIT)

    const now = Date.parse(this.#clock())
    return pool
      .map((entry) => rank(entry, terms, now))
      .sort((left, right) =>
        right.score - left.score
        || right.entry.occurredAt.localeCompare(left.entry.occurredAt)
        || left.entry.memoryId.localeCompare(right.entry.memoryId))
      .slice(0, limit)
  }

  #candidates(
    employeeId: string,
    scopes: readonly EmployeeMemoryScope[],
    terms: readonly string[],
  ): EmployeeMemoryIndexEntry[] {
    if (this.#fts5) {
      try {
        const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
        const rows = this.#database
          .prepare(
            `SELECT entry.* FROM employee_memory_index_fts AS fts
             INNER JOIN employee_memory_index AS entry ON entry.memory_id = fts.memory_id
             WHERE employee_memory_index_fts MATCH ?
               AND entry.employee_id = ?
               AND entry.scope IN (${scopes.map(() => '?').join(', ')})
             LIMIT ?`,
          )
          .all(match, employeeId, ...scopes, MAX_SEARCH_LIMIT)
        if (rows.length > 0) return rows.map(mapEntry)
      } catch {
        // A SQLite build can expose FTS5 but reject a tokenizer or query form.
        // The portable LIKE path below stays the contract.
      }
    }
    const clause = terms.map(() => '(entry.summary LIKE ? ESCAPE \'\\\' OR entry.keywords_json LIKE ? ESCAPE \'\\\' OR entry.entities_json LIKE ? ESCAPE \'\\\')').join(' OR ')
    const parameters = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`
      return [pattern, pattern, pattern]
    })
    return this.#database
      .prepare(
        `SELECT entry.* FROM employee_memory_index AS entry
         WHERE entry.employee_id = ?
           AND entry.scope IN (${scopes.map(() => '?').join(', ')})
           AND (${clause})
         ORDER BY entry.occurred_at DESC, entry.memory_id
         LIMIT ?`,
      )
      .all(employeeId, ...scopes, ...parameters, MAX_SEARCH_LIMIT)
      .map(mapEntry)
  }

  #initializeFts5(): boolean {
    const exists = (): boolean => this.#database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'employee_memory_index_fts'")
      .get() !== undefined
    // A read-only store must never write; it can still use a mirror that a
    // writable process already built.
    if (this.#readOnly) return exists()
    try {
      if (!exists()) {
        try {
          this.#database.exec(FTS_TABLE_SQL('trigram'))
        } catch {
          // trigram is the CJK-friendly tokenizer but is not in every build.
          this.#database.exec(FTS_TABLE_SQL('unicode61'))
        }
      }
      // The mirror is derived twice over. Rebuild it whenever it disagrees with
      // the index table, so a restore or an out-of-band delete can never
      // resurrect a memory the index no longer holds.
      const mirrored = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM employee_memory_index_fts').get() as { count: number }).count)
      const indexed = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM employee_memory_index').get() as { count: number }).count)
      if (mirrored !== indexed) {
        this.#database.exec('DELETE FROM employee_memory_index_fts')
        this.#database.exec(
          `INSERT INTO employee_memory_index_fts (memory_id, employee_id, scope, content)
           SELECT memory_id, employee_id, scope,
                  summary || ' ' || keywords_json || ' ' || entities_json
           FROM employee_memory_index`,
        )
      }
      return true
    } catch {
      return false
    }
  }

  #syncFts(entry: EmployeeMemoryIndexEntry): void {
    if (!this.#fts5) return
    try {
      this.#database.prepare('DELETE FROM employee_memory_index_fts WHERE memory_id = ?').run(entry.memoryId)
      this.#database
        .prepare(
          `INSERT INTO employee_memory_index_fts (memory_id, employee_id, scope, content)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          entry.memoryId,
          entry.employeeId,
          entry.scope,
          `${entry.summary} ${entry.keywords.join(' ')} ${entry.entities.join(' ')}`,
        )
    } catch {
      // Losing the optional mirror degrades to LIKE search, never to a wrong
      // answer: the durable row is already committed.
    }
  }
}

/** Lexical terms shared by the writer (keywords) and the reader (query). */
export function memoryIndexTerms(value: string): string[] {
  const normalized = value.normalize('NFC').toLocaleLowerCase('zh-CN')
  const latin = normalized.match(/[a-z0-9._-]{2,}/g) ?? []
  const han = normalized.match(/\p{Script=Han}{2,}/gu) ?? []
  const grams = han.flatMap((item) => item.length <= 4
    ? [item]
    : Array.from({ length: Math.min(6, item.length - 1) }, (_unused, index) => item.slice(index, index + 2)))
  return normalizeTerms([...latin, ...grams])
}

function searchTerms(query: string): string[] {
  return memoryIndexTerms(query).slice(0, MAX_TERMS)
}

function rank(entry: EmployeeMemoryIndexEntry, terms: readonly string[], now: number): EmployeeMemoryIndexHit {
  const haystack = `${entry.summary} ${entry.keywords.join(' ')}`.normalize('NFC').toLocaleLowerCase('zh-CN')
  const entityHaystack = entry.entities.join(' ').normalize('NFC').toLocaleLowerCase('zh-CN')
  const matchedKeywords: string[] = []
  const matchedEntities: string[] = []
  let keywordScore = 0
  let entityScore = 0
  for (const term of terms) {
    if (entityHaystack.includes(term)) {
      matchedEntities.push(term)
      // A named entity is a stronger signal than an incidental word overlap.
      entityScore += Math.min(18, term.length * 4)
    }
    if (haystack.includes(term)) {
      matchedKeywords.push(term)
      keywordScore += Math.min(12, term.length * 2)
    }
  }
  const occurred = Date.parse(entry.occurredAt)
  const ageDays = Number.isFinite(occurred) && Number.isFinite(now)
    ? Math.max(0, (now - occurred) / 86_400_000)
    : 0
  // Recency is a prior, not the dominant signal: a related old project should
  // still outrank an unrelated message from yesterday.
  const recencyScore = Math.max(0, 8 - Math.log2(ageDays + 1))
  const importanceScore = entry.importance * 10
  return {
    entry,
    score: keywordScore + entityScore + recencyScore + importanceScore,
    matchedKeywords,
    matchedEntities,
  }
}

function normalizeScopes(scopes: readonly EmployeeMemoryScope[]): EmployeeMemoryScope[] {
  return [...new Set(scopes)].sort()
}

function normalizeTerms(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize('NFC').trim().toLocaleLowerCase('zh-CN')).filter(Boolean))]
}

function clampImportance(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value))
}

function parseStrings(value: unknown): string[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function mapEntry(row: object): EmployeeMemoryIndexEntry {
  const value = row as Record<string, unknown>
  return {
    memoryId: String(value.memory_id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    employeeId: String(value.employee_id),
    scope: String(value.scope) as EmployeeMemoryScope,
    summary: String(value.summary),
    keywords: parseStrings(value.keywords_json),
    entities: parseStrings(value.entities_json),
    sourceMessageIds: parseStrings(value.source_message_ids_json),
    artifactRefs: parseStrings(value.artifact_refs_json),
    importance: Number(value.importance),
    occurredAt: String(value.occurred_at),
    updatedAt: String(value.updated_at),
  }
}
