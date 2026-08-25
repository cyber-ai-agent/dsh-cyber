import type { DatabaseSync } from 'node:sqlite'
import type {
  KnowledgeSearchInput as ContractKnowledgeSearchInput,
  KnowledgeSearchResult as ContractKnowledgeSearchResult,
} from '@dsh-cyber/contracts'

export interface KnowledgeSearchInput extends Omit<ContractKnowledgeSearchInput, 'limit'> {
  limit?: number
  maxChars?: number
}

export type KnowledgeSearchResult = ContractKnowledgeSearchResult & {
  sourceUrl?: string
  origin?: string
}

export interface KnowledgeSearchCapabilities {
  fts5: boolean
  trigram: boolean
  backend: 'fts5-trigram' | 'fts5' | 'portable'
}

/**
 * Repository-owned data access seam.  The search port must not become a
 * second Knowledge authority: callers provide chunks or an indexed search
 * implementation owned by WorldKnowledgeRepository.
 */
export interface KnowledgeSearchBackend {
  listChunks(worldId: string): Promise<readonly KnowledgeSearchResult[]> | readonly KnowledgeSearchResult[]
  searchIndexed?(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> | KnowledgeSearchResult[]
}

export interface KnowledgeSearchPort {
  readonly capabilities: KnowledgeSearchCapabilities
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]>
}

export class PortableKnowledgeSearchPort implements KnowledgeSearchPort {
  readonly capabilities: KnowledgeSearchCapabilities
  readonly #backend: KnowledgeSearchBackend

  constructor(backend: KnowledgeSearchBackend, capabilities: KnowledgeSearchCapabilities = { fts5: false, trigram: false, backend: 'portable' }) {
    this.#backend = backend
    this.capabilities = capabilities
  }

  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    const query = normalizeQuery(input.query)
    const limit = clamp(input.limit, 6, 1, 20)
    const maxChars = clamp(input.maxChars, 6_000, 500, 24_000)
    const indexed = this.#backend.searchIndexed === undefined ? undefined : await this.#backend.searchIndexed({ ...input, query, limit, maxChars })
    const ranked = indexed === undefined
      ? rankPortable(await this.#backend.listChunks(input.worldId), query)
      : indexed
    return capResults(ranked.filter((item) => item.worldId === input.worldId), limit, maxChars)
  }
}

/** Detect SQLite build capabilities without loading a native extension. */
export function detectKnowledgeSearchCapabilities(database?: Pick<DatabaseSync, 'prepare' | 'exec'>): KnowledgeSearchCapabilities {
  if (database === undefined) return { fts5: false, trigram: false, backend: 'portable' }
  let fts5 = false
  try {
    const row = database.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as { enabled?: unknown } | undefined
    fts5 = row?.enabled === 1 || row?.enabled === true
  } catch { /* Older SQLite builds do not expose compile options. */ }
  if (!fts5) {
    try {
      database.exec("CREATE VIRTUAL TABLE temp.dsh_knowledge_capability_fts USING fts5(value, tokenize='unicode61')")
      database.exec('DROP TABLE temp.dsh_knowledge_capability_fts')
      fts5 = true
    } catch { /* FTS5 unavailable; portable search remains the contract. */ }
  }
  if (!fts5) return { fts5: false, trigram: false, backend: 'portable' }
  let trigram = false
  try {
    database.exec("CREATE VIRTUAL TABLE temp.dsh_knowledge_capability_trigram USING fts5(value, tokenize='trigram')")
    database.exec('DROP TABLE temp.dsh_knowledge_capability_trigram')
    trigram = true
  } catch { /* unicode61 FTS5 is still useful; CJK falls back to portable ranking. */ }
  return { fts5: true, trigram, backend: trigram ? 'fts5-trigram' : 'fts5' }
}

export function createKnowledgeSearchPort(backend: KnowledgeSearchBackend, database?: Pick<DatabaseSync, 'prepare' | 'exec'>): KnowledgeSearchPort {
  return new PortableKnowledgeSearchPort(backend, detectKnowledgeSearchCapabilities(database))
}

/** Adapt the persistence repository without moving SQLite authority into Server. */
export function createKnowledgeSearchPortFromRepository(repository: {
  listChunks(worldId: string): readonly RepositorySearchRow[] | Promise<readonly RepositorySearchRow[]>
  searchIndexed?(input: KnowledgeSearchInput): readonly RepositorySearchRow[] | Promise<readonly RepositorySearchRow[]>
  capabilities?: Partial<KnowledgeSearchCapabilities>
}): KnowledgeSearchPort {
  const backend: KnowledgeSearchBackend = {
    listChunks: async (worldId) => normalizeRepositoryRows(await repository.listChunks(worldId)),
    ...(repository.searchIndexed === undefined ? {} : { searchIndexed: async (input) => normalizeRepositoryRows(await repository.searchIndexed!(input)) }),
  }
  const capabilities: KnowledgeSearchCapabilities = {
    fts5: repository.capabilities?.fts5 ?? false,
    trigram: repository.capabilities?.trigram ?? false,
    backend: repository.capabilities?.backend ?? 'portable',
  }
  return new PortableKnowledgeSearchPort(backend, capabilities)
}

interface RepositorySearchRow {
  worldId: string
  documentId: string
  chunkId: string
  ordinal: number
  content: string
  score: number
  title?: string
  relativePath?: string
  collectionId?: string
  sourceUrl?: string
  origin?: string
}

function normalizeRepositoryRows(rows: readonly RepositorySearchRow[]): KnowledgeSearchResult[] {
  return rows.map((row) => ({
    worldId: row.worldId,
    documentId: row.documentId,
    chunkId: row.chunkId,
    ordinal: row.ordinal,
    content: row.content,
    score: row.score,
    title: row.title ?? '未命名资料',
    relativePath: row.relativePath ?? '',
    ...(row.collectionId === undefined ? {} : { collectionId: row.collectionId }),
    ...(row.sourceUrl === undefined ? {} : { sourceUrl: row.sourceUrl }),
    ...(row.origin === undefined ? {} : { origin: row.origin }),
  }))
}

function rankPortable(items: readonly KnowledgeSearchResult[], query: string): KnowledgeSearchResult[] {
  const tokens = queryTokens(query)
  if (tokens.length === 0) return []
  return items
    .map((item) => {
      const haystack = `${item.title ?? ''}\n${item.relativePath ?? ''}\n${item.content}`.toLocaleLowerCase()
      let score = 0
      for (const token of tokens) {
        let index = haystack.indexOf(token)
        while (index >= 0) {
          score += token.length > 1 ? 1 : 0.25
          index = haystack.indexOf(token, index + token.length)
        }
      }
      const phrase = query.toLocaleLowerCase()
      if (phrase.length > 1 && haystack.includes(phrase)) score += 4
      if (score === 0) return undefined
      return { ...item, score }
    })
    .filter((item): item is KnowledgeSearchResult => item !== undefined)
    .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId) || left.ordinal - right.ordinal)
}

function queryTokens(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  const tokens = normalized.split(/[^\p{L}\p{N}\p{Script=Han}]+/u).filter(Boolean)
  const cjk = Array.from(normalized).filter((character) => /\p{Script=Han}/u.test(character))
  for (let index = 0; index + 1 < cjk.length; index += 1) tokens.push(`${cjk[index]}${cjk[index + 1]}`)
  return [...new Set(tokens)].slice(0, 64)
}

function capResults(items: readonly KnowledgeSearchResult[], limit: number, maxChars: number): KnowledgeSearchResult[] {
  const output: KnowledgeSearchResult[] = []
  let chars = 0
  for (const item of items) {
    if (output.length >= limit || chars >= maxChars) break
    const remaining = maxChars - chars
    if (remaining < 1) break
    const content = item.content.slice(0, remaining)
    output.push({ ...item, content })
    chars += content.length
  }
  return output
}

function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/g, ' ')
  if (!query || query.length > 500) throw new Error('Knowledge search query is invalid')
  return query
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)))
}
