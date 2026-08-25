import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  WorldArtifact,
  WorldArtifactFilter,
  WorldArtifactKind,
  WorldArtifactPublication,
  WorldArtifactPublishInput,
  WorldArtifactStatus,
  WorldArtifactVersion,
  WorldArtifactVersionInput,
} from '@dsh-cyber/contracts'

import { EntityNotFoundError, PersistenceError } from './errors.js'

export interface WorldArtifactRepositoryOptions {
  clock?: () => string
  idFactory?: () => string
}

/**
 * SQLite registry for durable World artifacts.
 *
 * The repository owns metadata and provenance only. It never reads or writes
 * the workspace filesystem, so publication security (containment, hashing,
 * staging and atomic file moves) remains in the Host service.
 */
export class WorldArtifactRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #idFactory: () => string

  constructor(database: DatabaseSync, options: WorldArtifactRepositoryOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  get(worldId: string, artifactId: string): WorldArtifact | undefined {
    const row = this.#database
      .prepare('SELECT * FROM world_artifacts WHERE world_id = ? AND id = ?')
      .get(worldId, artifactId)
    return row === undefined ? undefined : mapArtifact(row)
  }

  list(worldId: string, filter: WorldArtifactFilter = {}): WorldArtifact[] {
    assertNonEmpty(worldId, 'World id')
    const clauses = ['world_id = ?']
    const parameters: Array<string | number> = [worldId]

    if (filter.query !== undefined) {
      const query = filter.query.trim()
      if (query) {
        clauses.push('(title LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')')
        const escaped = escapeLike(query)
        parameters.push(`%${escaped}%`, `%${escaped}%`)
      }
    }
    if (filter.kind !== undefined) {
      assertKind(filter.kind)
      clauses.push('kind = ?')
      parameters.push(filter.kind)
    }
    if (filter.status !== undefined) {
      assertStatus(filter.status)
      clauses.push('status = ?')
      parameters.push(filter.status)
    }
    if (filter.createdByKind !== undefined) {
      if (filter.createdByKind !== 'owner' && filter.createdByKind !== 'employee') {
        throw new PersistenceError(`Unknown World artifact creator kind: ${filter.createdByKind}`)
      }
      clauses.push('created_by_kind = ?')
      parameters.push(filter.createdByKind)
    }
    if (filter.createdById !== undefined) {
      assertNonEmpty(filter.createdById, 'Artifact creator id')
      clauses.push('created_by_id = ?')
      parameters.push(filter.createdById.trim())
    }
    if (filter.employeeId !== undefined) {
      assertNonEmpty(filter.employeeId, 'Artifact employee id')
      clauses.push(
        'EXISTS (SELECT 1 FROM world_artifact_versions version WHERE version.world_id = world_artifacts.world_id AND version.artifact_id = world_artifacts.id AND version.employee_id = ?)',
      )
      parameters.push(filter.employeeId.trim())
    }

    const pageSize = filter.pageSize === undefined ? undefined : clampPageSize(filter.pageSize)
    const page = filter.page === undefined ? 1 : clampPage(filter.page)
    const pagination = pageSize === undefined ? '' : ' LIMIT ? OFFSET ?'
    if (pageSize !== undefined) parameters.push(pageSize, (page - 1) * pageSize)

    return this.#database
      .prepare(
        `SELECT * FROM world_artifacts
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC, id DESC${pagination}`,
      )
      .all(...parameters)
      .map(mapArtifact)
  }

  getVersion(worldId: string, artifactId: string, version: number): WorldArtifactVersion | undefined {
    assertVersion(version)
    const row = this.#database
      .prepare(
        `SELECT version.* FROM world_artifact_versions version
         INNER JOIN world_artifacts artifact
           ON artifact.id = version.artifact_id
          AND artifact.world_id = version.world_id
         WHERE version.world_id = ? AND version.artifact_id = ? AND version.version = ?`,
      )
      .get(worldId, artifactId, version)
    return row === undefined ? undefined : mapVersion(row)
  }

  listVersions(worldId: string, artifactId: string): WorldArtifactVersion[] {
    return this.#database
      .prepare(
        `SELECT version.* FROM world_artifact_versions version
         INNER JOIN world_artifacts artifact
           ON artifact.id = version.artifact_id
          AND artifact.world_id = version.world_id
         WHERE version.world_id = ? AND version.artifact_id = ?
         ORDER BY version.version ASC`,
      )
      .all(worldId, artifactId)
      .map(mapVersion)
  }

  getVersionByIdempotencyKey(worldId: string, idempotencyKey: string): WorldArtifactVersion | undefined {
    assertNonEmpty(idempotencyKey, 'Artifact idempotency key')
    const row = this.#database
      .prepare(
        `SELECT * FROM world_artifact_versions
         WHERE world_id = ? AND idempotency_key = ?`,
      )
      .get(worldId, idempotencyKey.trim())
    return row === undefined ? undefined : mapVersion(row)
  }

  /** Publish a new artifact or append one immutable version to an existing one. */
  publish(input: WorldArtifactPublishInput): WorldArtifactPublication {
    return this.#withTransaction(() => this.#publishUnlocked(input))
  }

  /** Descriptive alias used by host services. */
  publishArtifact(input: WorldArtifactPublishInput): WorldArtifactPublication {
    return this.publish(input)
  }

  /** Create the first version of a new logical artifact. */
  create(input: WorldArtifactPublishInput): WorldArtifactPublication {
    if (input.artifactId !== undefined) {
      throw new PersistenceError('New World artifact cannot provide an existing artifact id')
    }
    return this.publish(input)
  }

  createArtifact(input: WorldArtifactPublishInput): WorldArtifactPublication {
    return this.create(input)
  }

  /** Append exactly one new version; existing version rows are never updated. */
  createVersion(input: WorldArtifactVersionInput): WorldArtifactPublication {
    const artifact = this.get(input.worldId, input.artifactId)
    if (artifact === undefined) {
      throw new EntityNotFoundError(`World artifact not found: ${input.artifactId}`)
    }
    const publishInput: WorldArtifactPublishInput = {
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      artifactId: input.artifactId,
      title: artifact.title,
      kind: artifact.kind,
      relativePath: input.relativePath,
      byteLength: input.byteLength,
      sha256: input.sha256,
      createdByKind: artifact.createdByKind,
      createdById: artifact.createdById,
    }
    if (artifact.description !== undefined) publishInput.description = artifact.description
    if (input.entrypoint !== undefined) publishInput.entrypoint = input.entrypoint
    if (input.mimeType !== undefined) publishInput.mimeType = input.mimeType
    if (input.sourceRelativePath !== undefined) publishInput.sourceRelativePath = input.sourceRelativePath
    if (input.employeeId !== undefined) publishInput.employeeId = input.employeeId
    if (input.sessionId !== undefined) publishInput.sessionId = input.sessionId
    if (input.workTurnId !== undefined) publishInput.workTurnId = input.workTurnId
    if (input.agentRunId !== undefined) publishInput.agentRunId = input.agentRunId
    if (input.idempotencyKey !== undefined) publishInput.idempotencyKey = input.idempotencyKey
    if (input.createdAt !== undefined) publishInput.createdAt = input.createdAt
    return this.publish(publishInput)
  }

  appendVersion(input: WorldArtifactVersionInput): WorldArtifactPublication {
    return this.createVersion(input)
  }

  rename(worldId: string, artifactId: string, title: string, description?: string): WorldArtifact {
    assertNonEmpty(title, 'Artifact title')
    const current = this.get(worldId, artifactId)
    if (current === undefined) throw new EntityNotFoundError(`World artifact not found: ${artifactId}`)
    const updatedAt = this.#clock()
    this.#database
      .prepare(
        `UPDATE world_artifacts SET title = ?, description = ?, updated_at = ?
         WHERE world_id = ? AND id = ?`,
      )
      .run(title.trim(), description?.trim() || null, updatedAt, worldId, artifactId)
    return this.get(worldId, artifactId)!
  }

  setStatus(worldId: string, artifactId: string, status: WorldArtifactStatus): WorldArtifact {
    assertStatus(status)
    const current = this.get(worldId, artifactId)
    if (current === undefined) throw new EntityNotFoundError(`World artifact not found: ${artifactId}`)
    this.#database
      .prepare(
        `UPDATE world_artifacts SET status = ?, updated_at = ?
         WHERE world_id = ? AND id = ?`,
      )
      .run(status, this.#clock(), worldId, artifactId)
    return this.get(worldId, artifactId)!
  }

  archive(worldId: string, artifactId: string): WorldArtifact {
    return this.setStatus(worldId, artifactId, 'archived')
  }

  restore(worldId: string, artifactId: string): WorldArtifact {
    return this.setStatus(worldId, artifactId, 'active')
  }

  remove(worldId: string, artifactId: string): boolean {
    const result = this.#database
      .prepare('DELETE FROM world_artifacts WHERE world_id = ? AND id = ?')
      .run(worldId, artifactId)
    return Number(result.changes) === 1
  }

  #publishUnlocked(input: WorldArtifactPublishInput): WorldArtifactPublication {
    const world = this.#assertWorld(input.workspaceId, input.worldId)
    const normalized = normalizePublishInput(input)
    this.#assertProvenance(world.workspaceId, world.id, normalized)

    const existingByKey = normalized.idempotencyKey === undefined
      ? undefined
      : this.getVersionByIdempotencyKey(world.id, normalized.idempotencyKey)
    if (existingByKey !== undefined) {
      if (normalized.artifactId !== undefined && existingByKey.artifactId !== normalized.artifactId) {
        throw new PersistenceError('Artifact idempotency key is already bound to another artifact')
      }
      const artifact = this.get(world.id, existingByKey.artifactId)
      if (artifact === undefined) throw new PersistenceError('Idempotent artifact publication lost its artifact')
      assertSamePublication(artifact, existingByKey, normalized)
      return { artifact, version: existingByKey, created: false }
    }

    const now = normalized.createdAt ?? this.#clock()
    assertTimestamp(now, 'Artifact createdAt')
    const artifactId = normalized.artifactId ?? this.#idFactory()
    const existingScope = this.#database
      .prepare('SELECT world_id FROM world_artifacts WHERE id = ?')
      .get(artifactId) as { world_id?: string } | undefined
    if (existingScope !== undefined && existingScope.world_id !== world.id) {
      throw new EntityNotFoundError(`World artifact not found in current world: ${artifactId}`)
    }
    const existingArtifact = this.get(world.id, artifactId)
    // The trusted Host may allocate the stable artifact id before copying
    // bytes so the directory and SQLite identity stay identical. Explicit
    // append semantics remain in createVersion(), which requires existence.
    if (existingArtifact === undefined) {
      this.#database
        .prepare(
          `INSERT INTO world_artifacts
           (id, workspace_id, world_id, title, description, kind, status, current_version,
            created_by_kind, created_by_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          world.workspaceId,
          world.id,
          normalized.title,
          normalized.description ?? null,
          normalized.kind,
          normalized.createdByKind,
          normalized.createdById,
          now,
          now,
        )
    } else {
      if (existingArtifact.workspaceId !== world.workspaceId) {
        throw new PersistenceError('World artifact workspace scope mismatch')
      }
      if (existingArtifact.kind !== normalized.kind) {
        throw new PersistenceError('Artifact kind cannot change across versions')
      }
      if (
        existingArtifact.createdByKind !== normalized.createdByKind ||
        existingArtifact.createdById !== normalized.createdById
      ) {
        throw new PersistenceError('Artifact provenance cannot change across versions')
      }
      if (
        existingArtifact.title !== normalized.title ||
        (normalized.description !== undefined &&
          (existingArtifact.description ?? undefined) !== normalized.description)
      ) {
        throw new PersistenceError('Artifact metadata must be changed through rename')
      }
    }

    const versionNumber = existingArtifact?.currentVersion === undefined
      ? 1
      : existingArtifact.currentVersion + 1
    this.#database
      .prepare(
        `INSERT INTO world_artifact_versions
         (artifact_id, workspace_id, world_id, version, relative_path, entrypoint, mime_type,
          byte_length, sha256, source_relative_path, employee_id, session_id, work_turn_id,
          agent_run_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        world.workspaceId,
        world.id,
        versionNumber,
        normalized.relativePath,
        normalized.entrypoint ?? null,
        normalized.mimeType ?? null,
        normalized.byteLength,
        normalized.sha256,
        normalized.sourceRelativePath ?? null,
        normalized.employeeId ?? null,
        normalized.sessionId ?? null,
        normalized.workTurnId ?? null,
        normalized.agentRunId ?? null,
        normalized.idempotencyKey ?? null,
        now,
      )
    this.#database
      .prepare(
        `UPDATE world_artifacts SET current_version = ?, status = CASE WHEN status = 'missing' THEN 'active' ELSE status END,
         updated_at = ? WHERE world_id = ? AND id = ?`,
      )
      .run(versionNumber, now, world.id, artifactId)

    const artifact = this.get(world.id, artifactId)
    const version = this.getVersion(world.id, artifactId, versionNumber)
    if (artifact === undefined || version === undefined) {
      throw new PersistenceError('World artifact publication could not be read after insert')
    }
    return { artifact, version, created: true }
  }

  #assertWorld(workspaceId: string, worldId: string): { id: string; workspaceId: string } {
    assertNonEmpty(workspaceId, 'Workspace id')
    assertNonEmpty(worldId, 'World id')
    const row = this.#database
      .prepare('SELECT id, workspace_id FROM worlds WHERE id = ?')
      .get(worldId) as { id?: string; workspace_id?: string } | undefined
    if (row === undefined) throw new EntityNotFoundError(`World not found: ${worldId}`)
    if (row.workspace_id !== workspaceId) throw new PersistenceError('World does not belong to workspace')
    return { id: worldId, workspaceId }
  }

  #assertProvenance(workspaceId: string, worldId: string, input: NormalizedPublishInput): void {
    if (input.createdByKind === 'employee') {
      if (input.createdById !== input.employeeId) {
        throw new PersistenceError('Employee-created artifact must identify its employee provenance')
      }
    }
    if (input.employeeId !== undefined) {
      const row = this.#database
        .prepare('SELECT workspace_id, world_id FROM employee_instances WHERE id = ?')
        .get(input.employeeId) as { workspace_id?: string; world_id?: string } | undefined
      if (row === undefined || row.workspace_id !== workspaceId || row.world_id !== worldId) {
        throw new PersistenceError('Artifact employee provenance is outside this world')
      }
    }
    if (input.sessionId !== undefined) {
      const row = this.#database
        .prepare('SELECT workspace_id, world_id FROM work_sessions WHERE id = ?')
        .get(input.sessionId) as { workspace_id?: string; world_id?: string } | undefined
      if (row === undefined || row.workspace_id !== workspaceId || row.world_id !== worldId) {
        throw new PersistenceError('Artifact session provenance is outside this world')
      }
    }
    if (input.workTurnId !== undefined) {
      const row = this.#database
        .prepare('SELECT workspace_id, world_id, session_id FROM work_turns WHERE id = ?')
        .get(input.workTurnId) as { workspace_id?: string; world_id?: string; session_id?: string } | undefined
      if (
        row === undefined ||
        row.workspace_id !== workspaceId ||
        row.world_id !== worldId ||
        (input.sessionId !== undefined && row.session_id !== input.sessionId)
      ) {
        throw new PersistenceError('Artifact work turn provenance is outside this world')
      }
    }
    if (input.agentRunId !== undefined) {
      const row = this.#database
        .prepare('SELECT workspace_id, world_id, session_id, turn_id, employee_id FROM agent_runs WHERE id = ?')
        .get(input.agentRunId) as {
          workspace_id?: string
          world_id?: string
          session_id?: string
          turn_id?: string
          employee_id?: string
        } | undefined
      if (
        row === undefined ||
        row.workspace_id !== workspaceId ||
        row.world_id !== worldId ||
        (input.sessionId !== undefined && row.session_id !== input.sessionId) ||
        (input.workTurnId !== undefined && row.turn_id !== input.workTurnId) ||
        (input.employeeId !== undefined && row.employee_id !== input.employeeId)
      ) {
        throw new PersistenceError('Artifact agent run provenance is outside this world')
      }
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
export class SqliteWorldArtifactRepository extends WorldArtifactRepository {}

interface NormalizedPublishInput {
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
  createdAt?: string
}

function normalizePublishInput(input: WorldArtifactPublishInput): NormalizedPublishInput {
  assertKind(input.kind)
  if (input.createdByKind !== 'owner' && input.createdByKind !== 'employee') {
    throw new PersistenceError(`Unknown World artifact creator kind: ${input.createdByKind}`)
  }
  const title = input.title.trim()
  const createdById = input.createdById.trim()
  assertNonEmpty(title, 'Artifact title')
  assertNonEmpty(createdById, 'Artifact creator id')
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new PersistenceError('Artifact byte length must be a non-negative integer')
  }
  const sha256 = input.sha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new PersistenceError('Artifact sha256 must be a 64-character hexadecimal digest')
  const relativePath = assertRelativePath(input.relativePath, 'Artifact relative path')
  const entrypoint = input.entrypoint === undefined ? undefined : assertRelativePath(input.entrypoint, 'Artifact entrypoint')
  const sourceRelativePath = input.sourceRelativePath === undefined
    ? undefined
    : assertRelativePath(input.sourceRelativePath, 'Artifact source relative path')
  const idempotencyKey = input.idempotencyKey?.trim() || undefined
  if (idempotencyKey !== undefined && idempotencyKey.length > 512) {
    throw new PersistenceError('Artifact idempotency key is too long')
  }
  const normalized: NormalizedPublishInput = {
    workspaceId: input.workspaceId.trim(),
    worldId: input.worldId.trim(),
    title,
    kind: input.kind,
    relativePath,
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(input.mimeType?.trim() ? { mimeType: input.mimeType.trim() } : {}),
    byteLength: input.byteLength,
    sha256,
    createdByKind: input.createdByKind,
    createdById,
  }
  const artifactId = input.artifactId?.trim()
  const description = input.description?.trim()
  const employeeId = input.employeeId?.trim() || (input.createdByKind === 'employee' ? createdById : undefined)
  const sessionId = input.sessionId?.trim()
  const workTurnId = input.workTurnId?.trim()
  const agentRunId = input.agentRunId?.trim()
  if (artifactId) normalized.artifactId = artifactId
  if (description) normalized.description = description
  if (sourceRelativePath !== undefined) normalized.sourceRelativePath = sourceRelativePath
  if (employeeId) normalized.employeeId = employeeId
  if (sessionId) normalized.sessionId = sessionId
  if (workTurnId) normalized.workTurnId = workTurnId
  if (agentRunId) normalized.agentRunId = agentRunId
  if (idempotencyKey !== undefined) normalized.idempotencyKey = idempotencyKey
  if (input.createdAt !== undefined) normalized.createdAt = input.createdAt
  return normalized
}

function assertSamePublication(
  artifact: WorldArtifact,
  existing: WorldArtifactVersion,
  input: NormalizedPublishInput,
): void {
  if (
    artifact.kind !== input.kind ||
    artifact.title !== input.title ||
    (input.description !== undefined && (artifact.description ?? undefined) !== input.description) ||
    artifact.createdByKind !== input.createdByKind ||
    artifact.createdById !== input.createdById ||
    existing.relativePath !== input.relativePath ||
    existing.entrypoint !== input.entrypoint ||
    existing.mimeType !== input.mimeType ||
    existing.byteLength !== input.byteLength ||
    existing.sha256 !== input.sha256 ||
    existing.sourceRelativePath !== input.sourceRelativePath ||
    existing.employeeId !== input.employeeId ||
    existing.sessionId !== input.sessionId ||
    existing.workTurnId !== input.workTurnId ||
    existing.agentRunId !== input.agentRunId
  ) {
    throw new PersistenceError('Artifact idempotency key was reused with different publication metadata')
  }
}

function mapArtifact(row: unknown): WorldArtifact {
  const value = record(row, 'artifact')
  const kind = String(value.kind)
  const status = String(value.status)
  assertKind(kind)
  assertStatus(status)
  const artifact: WorldArtifact = {
    id: stringColumn(value, 'id'),
    workspaceId: stringColumn(value, 'workspace_id'),
    worldId: stringColumn(value, 'world_id'),
    title: stringColumn(value, 'title'),
    kind,
    status,
    currentVersion: integerColumn(value, 'current_version'),
    createdByKind: value.created_by_kind as 'owner' | 'employee',
    createdById: stringColumn(value, 'created_by_id'),
    createdAt: stringColumn(value, 'created_at'),
    updatedAt: stringColumn(value, 'updated_at'),
  }
  if (typeof value.description === 'string') artifact.description = value.description
  return artifact
}

function mapVersion(row: unknown): WorldArtifactVersion {
  const value = record(row, 'artifact version')
  const version: WorldArtifactVersion = {
    artifactId: stringColumn(value, 'artifact_id'),
    version: integerColumn(value, 'version'),
    relativePath: stringColumn(value, 'relative_path'),
    byteLength: integerColumn(value, 'byte_length'),
    sha256: stringColumn(value, 'sha256'),
    createdAt: stringColumn(value, 'created_at'),
  }
  addOptionalString(value, 'entrypoint', version, 'entrypoint')
  addOptionalString(value, 'mime_type', version, 'mimeType')
  addOptionalString(value, 'source_relative_path', version, 'sourceRelativePath')
  addOptionalString(value, 'employee_id', version, 'employeeId')
  addOptionalString(value, 'session_id', version, 'sessionId')
  addOptionalString(value, 'work_turn_id', version, 'workTurnId')
  addOptionalString(value, 'agent_run_id', version, 'agentRunId')
  addOptionalString(value, 'idempotency_key', version, 'idempotencyKey')
  return version
}

function assertKind(value: string): asserts value is WorldArtifactKind {
  if (!['image', 'html', 'markdown', 'document', 'code', 'data', 'archive', 'project', 'other'].includes(value)) {
    throw new PersistenceError(`Unknown World artifact kind: ${value}`)
  }
}

function assertStatus(value: string): asserts value is WorldArtifactStatus {
  if (!['active', 'archived', 'missing'].includes(value)) {
    throw new PersistenceError(`Unknown World artifact status: ${value}`)
  }
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new PersistenceError('Artifact version must be a positive integer')
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new PersistenceError(`${label} must be a valid ISO timestamp`)
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new PersistenceError(`${label} cannot be empty`)
}

function assertRelativePath(value: string, label: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  assertNonEmpty(normalized, label)
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new PersistenceError(`${label} must be relative to the World root`)
  }
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PersistenceError(`${label} contains an unsafe path segment`)
  }
  return normalized
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value)) throw new PersistenceError('Artifact page size must be finite')
  return Math.min(100, Math.max(1, Math.floor(value)))
}

function clampPage(value: number): number {
  if (!Number.isFinite(value)) throw new PersistenceError('Artifact page must be finite')
  return Math.max(1, Math.floor(value))
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new PersistenceError(`Invalid ${label} row`)
  return value as Record<string, unknown>
}

function stringColumn(value: Record<string, unknown>, key: string): string {
  const entry = value[key]
  if (typeof entry !== 'string') throw new PersistenceError(`Invalid World artifact column: ${key}`)
  return entry
}

function integerColumn(value: Record<string, unknown>, key: string): number {
  const entry = Number(value[key])
  if (!Number.isSafeInteger(entry)) throw new PersistenceError(`Invalid World artifact integer column: ${key}`)
  return entry
}

function addOptionalString<K extends keyof WorldArtifactVersion>(
  value: Record<string, unknown>,
  databaseKey: string,
  target: WorldArtifactVersion,
  outputKey: K,
): void {
  if (typeof value[databaseKey] === 'string') {
    target[outputKey] = value[databaseKey] as never
  }
}
