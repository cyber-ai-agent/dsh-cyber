import type { IsoTimestamp } from './index.js'

/** Provider-neutral kinds of durable assets a World can publish. */
export type WorldArtifactKind =
  | 'image'
  | 'html'
  | 'markdown'
  | 'document'
  | 'code'
  | 'data'
  | 'archive'
  | 'project'
  | 'other'

/** Registry state is metadata state; file availability is checked by the host. */
export type WorldArtifactStatus = 'active' | 'archived' | 'missing'

export interface WorldArtifact {
  id: string
  workspaceId: string
  worldId: string
  title: string
  description?: string
  kind: WorldArtifactKind
  status: WorldArtifactStatus
  currentVersion: number
  createdByKind: 'owner' | 'employee'
  createdById: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/**
 * An immutable publication record. The logical artifact id remains stable while
 * each successful publication gets a new version row.
 */
export interface WorldArtifactVersion {
  artifactId: string
  version: number
  relativePath: string
  entrypoint?: string
  mimeType?: string
  byteLength: number
  sha256: string
  sourceRelativePath?: string
  employeeId?: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
  /** Stable retry key for one publication request, when supplied by the host. */
  idempotencyKey?: string
  createdAt: IsoTimestamp
}

/**
 * One published version plus the run identity that produced it.
 *
 * This is the join the World Trace needs to answer "产出了什么结果" without
 * loading the registry twice or copying artifact state into the trace.
 */
export interface WorldArtifactRunProvenance {
  artifactId: string
  title: string
  kind: WorldArtifactKind
  version: number
  createdAt: IsoTimestamp
  employeeId?: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
}

/** World-scoped registry query. Unknown fields are intentionally not accepted. */
export interface WorldArtifactFilter {
  query?: string
  kind?: WorldArtifactKind
  status?: WorldArtifactStatus
  createdByKind?: 'owner' | 'employee'
  createdById?: string
  employeeId?: string
  page?: number
  pageSize?: number
}

/** A manifest entry is a publish request, never an authority decision. */
export interface WorldArtifactPublishManifestEntry {
  path: string
  title: string
  kind: WorldArtifactKind
  entrypoint?: string
  description?: string
}

export interface WorldArtifactPublishManifest {
  schemaVersion: 1
  artifacts: WorldArtifactPublishManifestEntry[]
}

/**
 * Metadata submitted by a trusted Host after it has verified the source file.
 * The repository stores metadata only; file copying and hashing remain Host
 * responsibilities.
 */
export interface WorldArtifactPublishInput {
  workspaceId: string
  worldId: string
  artifactId?: string
  title: string
  description?: string
  kind: WorldArtifactKind
  relativePath: string
  entrypoint?: string
  mimeType?: string
  byteLength: number
  sha256: string
  sourceRelativePath?: string
  createdByKind: 'owner' | 'employee'
  createdById: string
  employeeId?: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
  idempotencyKey?: string
  createdAt?: IsoTimestamp
}

/** Explicit input for appending a new immutable version to an existing item. */
export interface WorldArtifactVersionInput {
  workspaceId: string
  worldId: string
  artifactId: string
  relativePath: string
  entrypoint?: string
  mimeType?: string
  byteLength: number
  sha256: string
  sourceRelativePath?: string
  employeeId?: string
  sessionId?: string
  workTurnId?: string
  agentRunId?: string
  idempotencyKey?: string
  createdAt?: IsoTimestamp
}

export interface WorldArtifactPublication {
  artifact: WorldArtifact
  version: WorldArtifactVersion
  /** False when an idempotent retry returned the already durable publication. */
  created: boolean
}

/** Descriptive aliases for host code that uses request-oriented naming. */
export type PublishWorldArtifactInput = WorldArtifactPublishInput
export type CreateWorldArtifactVersionInput = WorldArtifactVersionInput
export type WorldArtifactPublishRequest = WorldArtifactPublishManifestEntry
export type WorldArtifactPublish = WorldArtifactPublishInput
export type WorldArtifactListFilter = WorldArtifactFilter
