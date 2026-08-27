import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type { CompletionJob, CompletionJobDraft, JsonObject, JsonValue } from '@dsh-cyber/contracts'

import { PersistenceError } from './errors.js'

export interface CompletionJobRepositoryOptions {
  clock?: () => string
  idFactory?: () => string
}

export class CompletionJobRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #idFactory: () => string

  constructor(database: DatabaseSync, options: CompletionJobRepositoryOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  create(input: CompletionJobDraft): CompletionJob {
    const existing = this.getByIdempotencyKey(input.idempotencyKey)
    if (existing !== undefined) {
      if (!sameDraft(existing, input)) throw new PersistenceError('Completion job idempotency key conflict')
      return existing
    }
    const now = this.#clock()
    const job: CompletionJob = {
      id: this.#idFactory(),
      ...input,
      status: 'pending',
      attemptCount: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    }
    this.#database.prepare(
      `INSERT INTO completion_jobs
       (id, idempotency_key, workspace_id, world_id, session_id, work_turn_id,
        agent_run_id, type, payload_json, status, attempt_count, available_at,
        lease_owner, lease_expires_at, last_error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)`,
    ).run(
      job.id, job.idempotencyKey, job.workspaceId, job.worldId, job.sessionId,
      job.workTurnId, job.agentRunId, job.type, JSON.stringify(job.payload),
      job.availableAt, job.createdAt, job.updatedAt,
    )
    return this.get(job.id)!
  }

  get(id: string): CompletionJob | undefined {
    const row = this.#database.prepare('SELECT * FROM completion_jobs WHERE id = ?').get(id)
    return row === undefined ? undefined : mapCompletionJob(row)
  }

  getByIdempotencyKey(idempotencyKey: string): CompletionJob | undefined {
    const row = this.#database.prepare('SELECT * FROM completion_jobs WHERE idempotency_key = ?').get(idempotencyKey)
    return row === undefined ? undefined : mapCompletionJob(row)
  }

  list(worldId: string, status?: CompletionJob['status']): CompletionJob[] {
    const rows = status === undefined
      ? this.#database.prepare('SELECT * FROM completion_jobs WHERE world_id = ? ORDER BY created_at DESC, id').all(worldId)
      : this.#database.prepare('SELECT * FROM completion_jobs WHERE world_id = ? AND status = ? ORDER BY created_at DESC, id').all(worldId, status)
    return rows.map(mapCompletionJob)
  }

  claim(owner: string, leaseDurationMs: number, now = this.#clock()): CompletionJob | undefined {
    const normalizedOwner = owner.trim()
    if (!normalizedOwner) throw new PersistenceError('Completion job lease owner cannot be empty')
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) throw new PersistenceError('Completion job lease duration must be positive')
    const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString()
    const row = this.#database.prepare(
      `UPDATE completion_jobs
       SET status = 'running', attempt_count = attempt_count + 1,
           lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = (
         SELECT id FROM completion_jobs
         WHERE available_at <= ?
           AND (
             status IN ('pending', 'retrying')
             OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )
         ORDER BY available_at, created_at, id
         LIMIT 1
       )
       RETURNING *`,
    ).get(normalizedOwner, leaseExpiresAt, now, now, now)
    return row === undefined ? undefined : mapCompletionJob(row)
  }

  renew(id: string, owner: string, leaseDurationMs: number, now = this.#clock()): CompletionJob {
    const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString()
    const row = this.#database.prepare(
      `UPDATE completion_jobs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
       RETURNING *`,
    ).get(leaseExpiresAt, now, id, owner)
    if (row === undefined) throw new PersistenceError('Completion job lease cannot be renewed')
    return mapCompletionJob(row)
  }

  complete(id: string, owner: string, now = this.#clock()): CompletionJob {
    return this.#settle(id, owner, 'completed', undefined, now, now)
  }

  retry(id: string, owner: string, errorCode: string, availableAt: string, now = this.#clock()): CompletionJob {
    return this.#settle(id, owner, 'retrying', errorCode, availableAt, now)
  }

  fail(id: string, owner: string, errorCode: string, now = this.#clock()): CompletionJob {
    return this.#settle(id, owner, 'failed', errorCode, now, now)
  }

  cancel(id: string, now = this.#clock()): CompletionJob {
    const row = this.#database.prepare(
      `UPDATE completion_jobs
       SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'retrying') RETURNING *`,
    ).get(now, id)
    if (row === undefined) throw new PersistenceError('Completion job cannot be cancelled')
    return mapCompletionJob(row)
  }

  recoverExpired(now = this.#clock()): number {
    return Number(this.#database.prepare(
      `UPDATE completion_jobs
       SET status = 'retrying', available_at = ?, lease_owner = NULL,
           lease_expires_at = NULL, last_error_code = 'worker-restarted', updated_at = ?
       WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    ).run(now, now, now).changes)
  }

  #settle(
    id: string,
    owner: string,
    status: 'completed' | 'retrying' | 'failed',
    errorCode: string | undefined,
    availableAt: string,
    now: string,
  ): CompletionJob {
    const row = this.#database.prepare(
      `UPDATE completion_jobs
       SET status = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?
       RETURNING *`,
    ).get(status, availableAt, errorCode ?? null, now, id, owner)
    if (row === undefined) throw new PersistenceError(`Completion job cannot enter ${status}`)
    return mapCompletionJob(row)
  }
}

export function mapCompletionJob(row: object): CompletionJob {
  const value = row as Record<string, unknown>
  const job: CompletionJob = {
    id: String(value.id),
    idempotencyKey: String(value.idempotency_key),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    sessionId: String(value.session_id),
    workTurnId: String(value.work_turn_id),
    agentRunId: String(value.agent_run_id),
    type: String(value.type),
    payload: JSON.parse(String(value.payload_json)) as JsonObject,
    status: value.status as CompletionJob['status'],
    attemptCount: Number(value.attempt_count),
    availableAt: String(value.available_at),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (typeof value.lease_owner === 'string') job.leaseOwner = value.lease_owner
  if (typeof value.lease_expires_at === 'string') job.leaseExpiresAt = value.lease_expires_at
  if (typeof value.last_error_code === 'string') job.lastErrorCode = value.last_error_code
  return job
}

function sameDraft(job: CompletionJob, input: CompletionJobDraft): boolean {
  return job.workspaceId === input.workspaceId
    && job.worldId === input.worldId
    && job.sessionId === input.sessionId
    && job.workTurnId === input.workTurnId
    && job.agentRunId === input.agentRunId
    && job.type === input.type
    && stableJson(job.payload) === stableJson(input.payload)
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
}
