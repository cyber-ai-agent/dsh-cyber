import type { IsoTimestamp } from './index.js'

/** Where a KnowledgeCollection's source tree came from. */
export type KnowledgeCollectionOrigin = 'folder' | 'zip' | 'manual' | 'web' | 'artifact'

/** Where an individual KnowledgeDocument's source content came from. */
export type KnowledgeDocumentOrigin = 'upload' | 'paste' | 'web' | 'filesystem' | 'artifact'

export type KnowledgeDocumentStatus = 'pending' | 'indexed' | 'failed' | 'missing'

/** A world-owned grouping for imported knowledge sources. */
export interface KnowledgeCollection {
  id: string
  worldId: string
  name: string
  description?: string
  origin: KnowledgeCollectionOrigin
  /** Path relative to the world's knowledge/library root. */
  relativeRoot: string
  /** Denormalized projection count; it can be rebuilt from documents. */
  documentCount: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/** Metadata for one source document. The source file remains the authority. */
export interface KnowledgeDocument {
  id: string
  workspaceId: string
  worldId: string
  collectionId?: string
  /** Path relative to the world's knowledge/library root. */
  relativePath: string
  title: string
  mimeType: string
  byteLength: number
  sha256: string
  origin: KnowledgeDocumentOrigin
  sourceUrl?: string
  artifactId?: string
  status: KnowledgeDocumentStatus
  /** Denormalized projection count; it can be rebuilt from chunks. */
  chunkCount: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  indexedAt?: IsoTimestamp
}

/** A searchable, replaceable projection of a KnowledgeDocument. */
export interface KnowledgeChunk {
  id: string
  worldId: string
  documentId: string
  ordinal: number
  content: string
  contentHash: string
  startOffset?: number
  endOffset?: number
  createdAt: IsoTimestamp
}

export interface KnowledgeCollectionInput {
  id?: string
  worldId: string
  name: string
  description?: string
  origin: KnowledgeCollectionOrigin
  relativeRoot: string
  createdAt?: IsoTimestamp
}

/** Input used to register source metadata before parsing/indexing. */
export interface KnowledgeDocumentInput {
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
  createdAt?: IsoTimestamp
}

/** Input for one chunk in a replaceable search projection. */
export interface KnowledgeChunkInput {
  id?: string
  worldId?: string
  documentId?: string
  ordinal: number
  content: string
  contentHash: string
  startOffset?: number
  endOffset?: number
  createdAt?: IsoTimestamp
}

export interface KnowledgeDocumentFilter {
  query?: string
  collectionId?: string
  origin?: KnowledgeDocumentOrigin
  status?: KnowledgeDocumentStatus
  page?: number
  pageSize?: number
}

export interface KnowledgeSearchInput {
  worldId: string
  query: string
  limit: number
}

/** Provider-neutral lexical result; ranking remains replaceable. */
export interface KnowledgeSearchResult {
  worldId: string
  documentId: string
  chunkId: string
  collectionId?: string
  title: string
  relativePath: string
  ordinal: number
  content: string
  score: number
}

export interface KnowledgeSearchPort {
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]>
}
