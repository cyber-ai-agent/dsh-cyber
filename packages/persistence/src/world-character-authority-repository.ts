import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  WORLD_CHARACTER_MANAGEMENT_PERMISSIONS,
  WORLD_CHARACTER_PERMISSIONS,
  WORLD_CHARACTER_ROLES,
  type CreateWorldPermissionRequestInput,
  type DecideWorldPermissionRequestInput,
  type WorldAuthorityChange,
  type WorldCharacterAuthority,
  type WorldCharacterPermission,
  type WorldCharacterRole,
  type WorldPermissionRequest,
  type WorldPermissionRequestStatus,
} from '@dsh-cyber/contracts'
import type { JsonObject } from '@dsh-cyber/contracts'

import { PersistenceError } from './errors.js'

export interface WorldCharacterAuthorityRepositoryOptions {
  clock?: () => string
  idFactory?: () => string
}

export interface SaveWorldCharacterAuthorityInput {
  worldId: string
  employeeId: string
  role: WorldCharacterRole
  permissionGrants: readonly WorldCharacterPermission[]
  createdAt?: string
  updatedAt?: string
}

export interface AppendWorldAuthorityChangeInput {
  id?: string
  worldId: string
  employeeId: string
  actorKind: 'owner' | 'employee'
  actorId: string
  previousRole?: WorldCharacterRole
  nextRole: WorldCharacterRole
  addedPermissions: readonly WorldCharacterPermission[]
  removedPermissions: readonly WorldCharacterPermission[]
  reason: string
  createdAt?: string
}

export interface CommitWorldAuthorityChangeInput {
  authority: SaveWorldCharacterAuthorityInput
  expectedAuthority?: WorldCharacterAuthority
  audit: AppendWorldAuthorityChangeInput
  event: {
    workspaceId: string
    worldId: string
    actorId: string
    actorKind: 'owner' | 'employee'
    payload: JsonObject
  }
}

/**
 * SQLite repository for the World-scoped authority ledger.
 *
 * It deliberately exposes no update/delete operation for the audit table.
 * The service performs policy checks; this repository enforces data shape,
 * world ownership and the append-only storage boundary.
 */
export class WorldCharacterAuthorityRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #idFactory: () => string

  constructor(database: DatabaseSync, options: WorldCharacterAuthorityRepositoryOptions = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  get(worldId: string, employeeId: string): WorldCharacterAuthority | undefined {
    const row = this.#database
      .prepare('SELECT * FROM world_character_authorities WHERE world_id = ? AND employee_id = ?')
      .get(worldId, employeeId)
    return row === undefined ? undefined : mapAuthority(row)
  }

  list(worldId: string): WorldCharacterAuthority[] {
    return this.#database
      .prepare(
        `SELECT * FROM world_character_authorities
         WHERE world_id = ? ORDER BY created_at, employee_id`,
      )
      .all(worldId)
      .map(mapAuthority)
  }

  listActive(worldId: string): WorldCharacterAuthority[] {
    return this.#database
      .prepare(
        `SELECT authority.* FROM world_character_authorities authority
         INNER JOIN employee_instances employee ON employee.id = authority.employee_id
         WHERE authority.world_id = ? AND employee.status <> 'archived'
         ORDER BY authority.created_at, authority.employee_id`,
      )
      .all(worldId)
      .map(mapAuthority)
  }

  hasPermission(worldId: string, employeeId: string, permission: WorldCharacterPermission): boolean {
    if (!isKnownPermission(permission)) return false
    const authority = this.get(worldId, employeeId)
    return authority?.permissionGrants.includes(permission) === true
  }

  save(input: SaveWorldCharacterAuthorityInput): WorldCharacterAuthority {
    assertRole(input.role)
    const employee = this.#assertEmployeeInWorld(input.worldId, input.employeeId)
    const permissions = normalizePermissions(input.permissionGrants, input.role)
    const createdAt = input.createdAt ?? this.#clock()
    const updatedAt = input.updatedAt ?? createdAt
    this.#database
      .prepare(
        `INSERT INTO world_character_authorities
         (world_id, employee_id, role, permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (world_id, employee_id) DO UPDATE SET
           role = excluded.role,
           permissions_json = excluded.permissions_json,
           updated_at = excluded.updated_at`,
      )
      .run(input.worldId, employee.id, input.role, JSON.stringify(permissions), createdAt, updatedAt)
    return this.get(input.worldId, input.employeeId)!
  }

  /** Alias used by host services that call the repository a projection store. */
  upsert(input: SaveWorldCharacterAuthorityInput): WorldCharacterAuthority {
    return this.save(input)
  }

  appendChange(input: AppendWorldAuthorityChangeInput): WorldAuthorityChange {
    assertRole(input.nextRole)
    if (input.previousRole !== undefined) assertRole(input.previousRole)
    if (input.actorKind !== 'owner' && input.actorKind !== 'employee') {
      throw new PersistenceError('Unknown World authority actor kind')
    }
    const actorId = input.actorId.trim()
    const reason = input.reason.trim()
    if (!actorId) throw new PersistenceError('World authority actor id cannot be empty')
    if (!reason) throw new PersistenceError('World authority change reason cannot be empty')
    const employee = this.#assertEmployeeInWorld(input.worldId, input.employeeId)
    const addedPermissions = normalizePermissions(input.addedPermissions)
    const removedPermissions = normalizePermissions(input.removedPermissions)
    const id = input.id?.trim() || this.#idFactory()
    const createdAt = input.createdAt ?? this.#clock()
    this.#database
      .prepare(
        `INSERT INTO world_authority_changes
         (id, world_id, employee_id, actor_kind, actor_id, previous_role, next_role,
          added_permissions_json, removed_permissions_json, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.worldId,
        employee.id,
        input.actorKind,
        actorId,
        input.previousRole ?? null,
        input.nextRole,
        JSON.stringify(addedPermissions),
        JSON.stringify(removedPermissions),
        reason,
        createdAt,
      )
    return this.getChange(id)!
  }

  getChange(id: string): WorldAuthorityChange | undefined {
    const row = this.#database.prepare('SELECT * FROM world_authority_changes WHERE id = ?').get(id)
    return row === undefined ? undefined : mapAuthorityChange(row)
  }

  listChanges(worldId: string, employeeId?: string): WorldAuthorityChange[] {
    const rows = employeeId === undefined
      ? this.#database
          .prepare(
            `SELECT * FROM world_authority_changes
             WHERE world_id = ? ORDER BY created_at, id`,
          )
          .all(worldId)
      : this.#database
          .prepare(
            `SELECT * FROM world_authority_changes
             WHERE world_id = ? AND employee_id = ? ORDER BY created_at, id`,
          )
          .all(worldId, employeeId)
    return rows.map(mapAuthorityChange)
  }

  /** Audit is append-only: this method intentionally has no delete/update counterpart. */
  listAudit(worldId: string, employeeId?: string): WorldAuthorityChange[] {
    return this.listChanges(worldId, employeeId)
  }

  createPermissionRequest(input: CreateWorldPermissionRequestInput): WorldPermissionRequest {
    assertPermission(input.permission)
    const employee = this.#assertEmployeeInWorld(input.worldId, input.employeeId)
    const context = this.#database
      .prepare(
        `SELECT
           world.workspace_id AS workspace_id,
           turn.world_id AS turn_world_id,
           turn.workspace_id AS turn_workspace_id,
           action.world_id AS action_world_id,
           action.character_id AS action_employee_id,
           action.work_turn_id AS action_work_turn_id
         FROM worlds world
         INNER JOIN work_turns turn ON turn.id = ?
         INNER JOIN skill_actions action ON action.id = ?
         WHERE world.id = ?`,
      )
      .get(input.workTurnId, input.skillActionId, input.worldId) as Record<string, unknown> | undefined
    if (
      context === undefined ||
      String(context.workspace_id) !== input.workspaceId ||
      String(context.turn_world_id) !== input.worldId ||
      String(context.turn_workspace_id) !== input.workspaceId ||
      String(context.action_world_id) !== input.worldId ||
      String(context.action_employee_id) !== employee.id ||
      String(context.action_work_turn_id ?? '') !== input.workTurnId
    ) {
      throw new PersistenceError('World permission request is not bound to the same world action')
    }
    const createdAt = input.createdAt ?? this.#clock()
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(input.expiresAt))) {
      throw new PersistenceError('World permission request timestamps are invalid')
    }
    if (Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
      throw new PersistenceError('World permission request must expire after creation')
    }
    const id = input.id?.trim() || this.#idFactory()
    this.#database
      .prepare(
        `INSERT INTO world_permission_requests
         (id, workspace_id, world_id, employee_id, work_turn_id, skill_action_id,
          permission, status, decision_scope, decided_by, decided_at, consumed_at,
          created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.worldId,
        employee.id,
        input.workTurnId,
        input.skillActionId,
        input.permission,
        createdAt,
        input.expiresAt,
      )
    return this.getPermissionRequest(id)!
  }

  getPermissionRequest(id: string): WorldPermissionRequest | undefined {
    const row = this.#database
      .prepare('SELECT * FROM world_permission_requests WHERE id = ?')
      .get(id)
    return row === undefined ? undefined : mapPermissionRequest(row)
  }

  /** Resolve an exact action gate inside its World; World scope is mandatory. */
  getPermissionRequestBySkillActionId(
    worldId: string,
    skillActionId: string,
  ): WorldPermissionRequest | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM world_permission_requests
         WHERE world_id = ? AND skill_action_id = ?`,
      )
      .get(worldId, skillActionId)
    if (row === undefined) return undefined
    this.expirePermissionRequest(String((row as Record<string, unknown>).id))
    const current = this.#database
      .prepare('SELECT * FROM world_permission_requests WHERE id = ?')
      .get(String((row as Record<string, unknown>).id))
    return current === undefined ? undefined : mapPermissionRequest(current)
  }

  /** Provider-neutral adapter name: SkillAction ids are globally unique. */
  getPermissionRequestForAction(
    skillActionId: string,
    permission?: WorldCharacterPermission,
  ): WorldPermissionRequest | undefined {
    const row = permission === undefined
      ? this.#database
          .prepare(
            `SELECT * FROM world_permission_requests
             WHERE skill_action_id = ?`,
          )
          .get(skillActionId)
      : this.#database
          .prepare(
            `SELECT * FROM world_permission_requests
             WHERE skill_action_id = ? AND permission = ?`,
          )
          .get(skillActionId, permission)
    if (row === undefined) return undefined
    const id = String((row as Record<string, unknown>).id)
    this.expirePermissionRequest(id)
    const current = this.#database
      .prepare('SELECT * FROM world_permission_requests WHERE id = ?')
      .get(id)
    return current === undefined ? undefined : mapPermissionRequest(current)
  }

  listPermissionRequestsBySkillActionId(worldId: string, skillActionId: string): WorldPermissionRequest[] {
    const request = this.getPermissionRequestBySkillActionId(worldId, skillActionId)
    return request === undefined ? [] : [request]
  }

  listPermissionRequestsByWorkTurnId(worldId: string, workTurnId: string): WorldPermissionRequest[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM world_permission_requests
         WHERE world_id = ? AND work_turn_id = ? ORDER BY created_at, id`,
      )
      .all(worldId, workTurnId)
    for (const row of rows) {
      const value = row as Record<string, unknown>
      this.expirePermissionRequest(String(value.id))
    }
    return this.#database
      .prepare(
        `SELECT * FROM world_permission_requests
         WHERE world_id = ? AND work_turn_id = ? ORDER BY created_at, id`,
      )
      .all(worldId, workTurnId)
      .map(mapPermissionRequest)
  }

  listPermissionRequestsForTurn(workTurnId: string): WorldPermissionRequest[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM world_permission_requests
         WHERE work_turn_id = ? ORDER BY created_at, id`,
      )
      .all(workTurnId)
    for (const row of rows) {
      const value = row as Record<string, unknown>
      this.expirePermissionRequest(String(value.id))
    }
    return this.#database
      .prepare(
        `SELECT * FROM world_permission_requests
         WHERE work_turn_id = ? ORDER BY created_at, id`,
      )
      .all(workTurnId)
      .map(mapPermissionRequest)
  }

  listPermissionRequests(worldId: string, status?: WorldPermissionRequestStatus): WorldPermissionRequest[] {
    this.expirePermissionRequests(worldId)
    const rows = status === undefined
      ? this.#database
          .prepare(
            `SELECT * FROM world_permission_requests
             WHERE world_id = ? ORDER BY created_at, id`,
          )
          .all(worldId)
      : this.#database
          .prepare(
            `SELECT * FROM world_permission_requests
             WHERE world_id = ? AND status = ? ORDER BY created_at, id`,
          )
          .all(worldId, status)
    return rows.map(mapPermissionRequest)
  }

  listPendingPermissionRequests(worldId: string): WorldPermissionRequest[] {
    return this.listPermissionRequests(worldId, 'pending')
  }

  decidePermissionRequest(
    id: string,
    input: DecideWorldPermissionRequestInput,
    now = this.#clock(),
  ): WorldPermissionRequest {
    if (input.decisionScope !== 'once' && input.decisionScope !== 'persistent' && input.decisionScope !== 'reject') {
      throw new PersistenceError('Unknown World permission request decision')
    }
    const decidedBy = input.decidedBy.trim()
    if (!decidedBy) throw new PersistenceError('World permission decision actor cannot be empty')
    const request = this.getPermissionRequest(id)
    if (request === undefined) throw new PersistenceError(`World permission request not found: ${id}`)
    if (request.status === 'expired') throw new PersistenceError('World permission request has expired')
    if (request.status !== 'pending') throw new PersistenceError('World permission request is already settled')
    if (Date.parse(request.expiresAt) <= Date.parse(now)) {
      this.#database
        .prepare(
          `UPDATE world_permission_requests
           SET status = 'expired', decided_at = ?, decided_by = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, decidedBy, id)
      throw new PersistenceError('World permission request has expired')
    }
    const status = input.decisionScope === 'reject' ? 'rejected' : 'approved'
    const decisionScope = input.decisionScope === 'reject' ? null : input.decisionScope
    const decidedAt = now
    const result = this.#database
      .prepare(
        `UPDATE world_permission_requests
         SET status = ?, decision_scope = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decisionScope, decidedBy, decidedAt, id)
    if (Number(result.changes) !== 1) throw new PersistenceError('World permission request was decided concurrently')
    return this.getPermissionRequest(id)!
  }

  consumePermissionRequest(id: string, consumedAt = this.#clock()): WorldPermissionRequest {
    const result = this.#database
      .prepare(
        `UPDATE world_permission_requests
         SET consumed_at = ?
         WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`,
      )
      .run(consumedAt, id)
    if (Number(result.changes) !== 1) {
      throw new PersistenceError('World permission request is not an unconsumed approval')
    }
    return this.getPermissionRequest(id)!
  }

  expirePermissionRequests(worldId?: string, now = this.#clock()): number {
    const result = worldId === undefined
      ? this.#database
          .prepare(
            `UPDATE world_permission_requests
             SET status = 'expired', decided_at = COALESCE(decided_at, ?)
             WHERE status = 'pending' AND expires_at <= ?`,
          )
          .run(now, now)
      : this.#database
          .prepare(
            `UPDATE world_permission_requests
             SET status = 'expired', decided_at = COALESCE(decided_at, ?)
             WHERE world_id = ? AND status = 'pending' AND expires_at <= ?`,
          )
          .run(now, worldId, now)
    return Number(result.changes)
  }

  expireAllPermissionRequests(now = this.#clock()): number {
    return this.expirePermissionRequests(undefined, now)
  }

  /** Compare-and-set expiry for one request; never turns a rejection into expiry. */
  expirePermissionRequest(id: string, now = this.#clock()): boolean {
    const result = this.#database
      .prepare(
        `UPDATE world_permission_requests
         SET status = 'expired', decided_at = COALESCE(decided_at, ?)
         WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
      )
      .run(now, id, now)
    return Number(result.changes) === 1
  }

  expirePermissionRequestResult(id: string, now = this.#clock()): WorldPermissionRequest {
    this.expirePermissionRequest(id, now)
    const request = this.getPermissionRequest(id)
    if (request === undefined) throw new PersistenceError(`World permission request not found: ${id}`)
    return request
  }

  #assertEmployeeInWorld(worldId: string, employeeId: string): { id: string; workspaceId: string; status: string } {
    const row = this.#database
      .prepare(
        `SELECT employee.id, employee.workspace_id, employee.status, employee.world_id,
                world.workspace_id AS world_workspace_id
         FROM employee_instances employee
         INNER JOIN worlds world ON world.id = ?
         WHERE employee.id = ?`,
      )
      .get(worldId, employeeId) as Record<string, unknown> | undefined
    if (
      row === undefined ||
      String(row.world_id) !== worldId ||
      String(row.workspace_id) !== String(row.world_workspace_id)
    ) {
      throw new PersistenceError('Employee does not belong to this world')
    }
    return { id: String(row.id), workspaceId: String(row.workspace_id), status: String(row.status) }
  }
}

/** Descriptive alias for dependency injection sites. */
export class SqliteWorldCharacterAuthorityRepository extends WorldCharacterAuthorityRepository {}

function assertRole(value: string): asserts value is WorldCharacterRole {
  if (!(WORLD_CHARACTER_ROLES as readonly string[]).includes(value)) {
    throw new PersistenceError(`Unknown World character role: ${value}`)
  }
}

function assertPermission(value: string): asserts value is WorldCharacterPermission {
  if (!(WORLD_CHARACTER_PERMISSIONS as readonly string[]).includes(value)) {
    throw new PersistenceError(`Unknown World character permission: ${value}`)
  }
}

function isKnownPermission(value: string): value is WorldCharacterPermission {
  return (WORLD_CHARACTER_PERMISSIONS as readonly string[]).includes(value)
}

function normalizePermissions(
  values: readonly WorldCharacterPermission[],
  role?: WorldCharacterRole,
): WorldCharacterPermission[] {
  const unique = new Set<string>()
  for (const value of values) {
    assertPermission(value)
    unique.add(value)
  }
  if (role === 'member') {
    for (const permission of unique) {
      if ((WORLD_CHARACTER_MANAGEMENT_PERMISSIONS as readonly string[]).includes(permission)) {
        throw new PersistenceError(`Member cannot hold management permission: ${permission}`)
      }
    }
  }
  const order = new Map<string, number>(WORLD_CHARACTER_PERMISSIONS.map((permission, index) => [permission, index]))
  return [...unique].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)) as WorldCharacterPermission[]
}

function mapAuthority(row: unknown): WorldCharacterAuthority {
  const value = record(row)
  const role = String(value.role)
  assertRole(role)
  return {
    worldId: stringColumn(value, 'world_id'),
    employeeId: stringColumn(value, 'employee_id'),
    role,
    permissionGrants: normalizePermissions(parseJson<WorldCharacterPermission>(value.permissions_json), role),
    createdAt: stringColumn(value, 'created_at'),
    updatedAt: stringColumn(value, 'updated_at'),
  }
}

function mapAuthorityChange(row: unknown): WorldAuthorityChange {
  const value = record(row)
  const nextRole = String(value.next_role)
  assertRole(nextRole)
  const previousRole = value.previous_role === null || value.previous_role === undefined
    ? undefined
    : String(value.previous_role)
  if (previousRole !== undefined) assertRole(previousRole)
  const actorKind = String(value.actor_kind)
  if (actorKind !== 'owner' && actorKind !== 'employee') throw new PersistenceError('Invalid authority audit actor kind')
  return {
    id: stringColumn(value, 'id'),
    worldId: stringColumn(value, 'world_id'),
    employeeId: stringColumn(value, 'employee_id'),
    actorKind,
    actorId: stringColumn(value, 'actor_id'),
    ...(previousRole === undefined ? {} : { previousRole }),
    nextRole,
    addedPermissions: normalizePermissions(parseJson<WorldCharacterPermission>(value.added_permissions_json)),
    removedPermissions: normalizePermissions(parseJson<WorldCharacterPermission>(value.removed_permissions_json)),
    reason: stringColumn(value, 'reason'),
    createdAt: stringColumn(value, 'created_at'),
  }
}

function mapPermissionRequest(row: unknown): WorldPermissionRequest {
  const value = record(row)
  const permission = stringColumn(value, 'permission')
  assertPermission(permission)
  const status = stringColumn(value, 'status')
  if (!['pending', 'approved', 'rejected', 'expired'].includes(status)) {
    throw new PersistenceError(`Invalid World permission request status: ${status}`)
  }
  const decisionScope = value.decision_scope === null || value.decision_scope === undefined
    ? undefined
    : String(value.decision_scope)
  if (decisionScope !== undefined && decisionScope !== 'once' && decisionScope !== 'persistent') {
    throw new PersistenceError(`Invalid World permission request decision scope: ${decisionScope}`)
  }
  return {
    id: stringColumn(value, 'id'),
    workspaceId: stringColumn(value, 'workspace_id'),
    worldId: stringColumn(value, 'world_id'),
    employeeId: stringColumn(value, 'employee_id'),
    workTurnId: stringColumn(value, 'work_turn_id'),
    skillActionId: stringColumn(value, 'skill_action_id'),
    permission,
    status: status as WorldPermissionRequestStatus,
    ...(decisionScope === undefined ? {} : { decisionScope: decisionScope as 'once' | 'persistent' }),
    ...optionalString(value, 'decided_by', 'decidedBy'),
    ...optionalString(value, 'decided_at', 'decidedAt'),
    ...optionalString(value, 'consumed_at', 'consumedAt'),
    createdAt: stringColumn(value, 'created_at'),
    expiresAt: stringColumn(value, 'expires_at'),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new PersistenceError('Invalid World authority row')
  return value as Record<string, unknown>
}

function stringColumn(value: Record<string, unknown>, key: string): string {
  const entry = value[key]
  if (typeof entry !== 'string') throw new PersistenceError(`Invalid World authority column: ${key}`)
  return entry
}

function parseJson<T extends string = string>(value: unknown): T[] {
  if (typeof value !== 'string') throw new PersistenceError('Invalid World authority JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new PersistenceError('Invalid World authority JSON')
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new PersistenceError('World authority permissions must be a string array')
  }
  return parsed as T[]
}

function optionalString<K extends string>(
  value: Record<string, unknown>,
  databaseKey: string,
  outputKey: K,
): Partial<Record<K, string>> {
  const entry = value[databaseKey]
  return typeof entry === 'string' ? { [outputKey]: entry } as Partial<Record<K, string>> : {}
}
