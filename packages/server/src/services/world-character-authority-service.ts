import type {
  UpdateWorldCharacterAuthorityInput,
  WorldAuthorityActor,
  WorldAuthorityChange,
  WorldCharacterAuthority,
  WorldCharacterPermission,
  WorldCharacterRole,
} from '@dsh-cyber/contracts'
import {
  RECOMMENDED_ADMIN_PERMISSIONS,
  WORLD_CHARACTER_MANAGEMENT_PERMISSIONS,
  WORLD_CHARACTER_PERMISSIONS,
} from '@dsh-cyber/contracts'
import type { EmployeeInstance } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'

export interface WorldCharacterAuthorityServiceOptions {
  clock?: () => string
}

/**
 * The single host authority for World role and permission decisions.
 *
 * Employee skill/capability grants intentionally never participate here. A
 * role is only an identity projection; every mutation is gated by the
 * persisted permission set and the target's current World membership.
 */
export class WorldCharacterAuthorityService {
  readonly #store: SqliteStore
  readonly #clock: () => string

  constructor(store: SqliteStore, options: WorldCharacterAuthorityServiceOptions = {}) {
    this.#store = store
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  get(worldId: string, employeeId: string): WorldCharacterAuthority | undefined {
    return this.#store.getWorldCharacterAuthority(worldId, employeeId)
  }

  list(worldId: string): WorldCharacterAuthority[] {
    return this.#store.listWorldCharacterAuthorities(worldId)
  }

  /**
   * Whether the owner ever revoked this permission from this character.
   *
   * A missing grant is not a decision — characters are recruited with grants
   * nobody has spoken about yet. A removal in the append-only ledger is.
   */
  wasPermissionRevoked(worldId: string, employeeId: string, permission: WorldCharacterPermission): boolean {
    if (!isKnownPermission(permission)) return false
    return this.#store.wasWorldCharacterPermissionRevoked(worldId, employeeId, permission)
  }

  hasPermission(worldId: string, employeeId: string, permission: WorldCharacterPermission): boolean {
    if (!isKnownPermission(permission)) return false
    const employee = this.#store.getEmployee(employeeId)
    if (
      employee === undefined ||
      employee.worldId !== worldId ||
      employee.status === 'archived'
    ) return false
    return this.#store.hasWorldCharacterPermission(worldId, employeeId, permission)
  }

  assertPermission(worldId: string, employeeId: string, permission: WorldCharacterPermission): void {
    const employee = this.#requireActiveEmployee(worldId, employeeId)
    if (!this.hasPermission(worldId, employee.id, permission)) {
      throw forbidden(
        'world_permission_required',
        `角色“${employee.displayName}”没有当前世界权限：${permission}`,
      )
    }
  }

  /**
   * Adds permissions, leaving role and every other grant untouched.
   *
   * The natural-language path used to send a whole replacement object with a
   * fabricated `role: 'member'`, which demoted administrators and erased
   * grants the user never mentioned.
   */
  grantPermissions(input: WorldAuthorityPatchInput): WorldCharacterAuthority {
    const current = this.get(input.worldId, input.targetEmployeeId)
    return this.updateAuthority({
      worldId: input.worldId,
      targetEmployeeId: input.targetEmployeeId,
      actor: input.actor,
      reason: input.reason,
      role: current?.role ?? 'member',
      permissionGrants: [...(current?.permissionGrants ?? []), ...input.permissions],
    })
  }

  /** Removes permissions, leaving role and every other grant untouched. */
  revokePermissions(input: WorldAuthorityPatchInput): WorldCharacterAuthority {
    const current = this.get(input.worldId, input.targetEmployeeId)
    const removed = new Set<string>(input.permissions)
    return this.updateAuthority({
      worldId: input.worldId,
      targetEmployeeId: input.targetEmployeeId,
      actor: input.actor,
      reason: input.reason,
      role: current?.role ?? 'member',
      permissionGrants: (current?.permissionGrants ?? []).filter((permission) => !removed.has(permission)),
    })
  }

  /**
   * Promotes to administrator with the recommended set applied in full.
   *
   * A promotion that carried forward only whatever the member happened to
   * hold produced administrators who could not administrate.
   */
  promote(input: WorldAuthorityPatchInput): WorldCharacterAuthority {
    const current = this.get(input.worldId, input.targetEmployeeId)
    const removed = new Set<string>(input.removePermissions ?? [])
    const next = [
      ...(current?.permissionGrants ?? []),
      ...RECOMMENDED_ADMIN_PERMISSIONS,
      ...input.permissions,
    ].filter((permission: WorldCharacterPermission) => !removed.has(permission))
    return this.updateAuthority({
      worldId: input.worldId,
      targetEmployeeId: input.targetEmployeeId,
      actor: input.actor,
      reason: input.reason,
      role: 'administrator',
      permissionGrants: next,
    })
  }

  /** Demotes to member, keeping every grant a member may legitimately hold. */
  demote(input: WorldAuthorityPatchInput): WorldCharacterAuthority {
    const current = this.get(input.worldId, input.targetEmployeeId)
    return this.updateAuthority({
      worldId: input.worldId,
      targetEmployeeId: input.targetEmployeeId,
      actor: input.actor,
      reason: input.reason,
      role: 'member',
      permissionGrants: current?.permissionGrants ?? [],
      // Demotion is the one operation whose whole purpose is to drop
      // management permissions, so the refusal does not apply.
      allowManagementStrip: true,
    })
  }

  updateAuthority(input: UpdateWorldCharacterAuthorityInput): WorldCharacterAuthority {
    const world = this.#store.getWorld(input.worldId)
    if (world === undefined) throw notFound('world_not_found', '世界不存在')
    if (world.status === 'archived') throw conflict('world_archived', '归档世界不能修改权限')

    const target = this.#requireActiveEmployee(input.worldId, input.targetEmployeeId)
    const reason = input.reason.trim()
    if (!reason) throw invalid('invalid_authority_reason', '权限变更原因不能为空')
    assertRole(input.role)
    const requestedPermissions = normalizePermissions(input.permissionGrants)

    const current = this.#currentAuthority(world.id, target)
    this.#assertActorMayManage(world.id, target, input.actor, requestedPermissions)

    // Management permissions are meaningful only for administrators. Asking
    // for one as a member is a real request with a real answer — promote
    // first — so it is refused with the offending list instead of being
    // silently dropped, which used to persist a partial row and leave no
    // trace of the rejection in the audit ledger.
    const refusedPermissions = input.role === 'member'
      ? requestedPermissions.filter((permission) => isManagementPermission(permission))
      : []
    if (refusedPermissions.length > 0 && input.allowManagementStrip !== true) {
      throw new WorldAuthorityPromotionRequiredError(target.displayName, refusedPermissions)
    }
    const nextPermissions = input.role === 'member'
      ? requestedPermissions.filter((permission) => !isManagementPermission(permission))
      : requestedPermissions
    const changed = current === undefined || current.role !== input.role || !samePermissions(current.permissionGrants, nextPermissions)
    if (!changed) return current!

    this.#assertLastAdministratorInvariant(world.id, target, current, input.role)
    const now = this.#clock()
    const addedPermissions = nextPermissions.filter((permission) => !current?.permissionGrants.includes(permission))
    const removedPermissions = (current?.permissionGrants ?? []).filter((permission) => !nextPermissions.includes(permission))
    return this.#store.commitWorldAuthorityChange({
      authority: {
        worldId: world.id,
        employeeId: target.id,
        role: input.role,
        permissionGrants: nextPermissions,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      },
      ...(current === undefined ? {} : { expectedAuthority: current }),
      audit: {
        worldId: world.id,
        employeeId: target.id,
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        ...(current === undefined ? {} : { previousRole: current.role }),
        nextRole: input.role,
        addedPermissions,
        removedPermissions,
        reason,
        createdAt: now,
      },
      event: {
        workspaceId: world.workspaceId,
        worldId: world.id,
        actorId: input.actor.id,
        actorKind: input.actor.kind,
        payload: {
          worldId: world.id,
          employeeId: target.id,
          previousRole: current?.role ?? null,
          nextRole: input.role,
          addedPermissions,
          removedPermissions,
          reason,
        },
      },
    })
  }

  listChanges(worldId: string, employeeId?: string): WorldAuthorityChange[] {
    return this.#store.listWorldAuthorityChanges(worldId, employeeId)
  }

  /** Reject archiving the last active administrator before employee mutation. */
  assertCanArchiveEmployee(worldId: string, employeeId: string): void {
    const employee = this.#requireActiveEmployee(worldId, employeeId)
    const authority = this.#currentAuthority(worldId, employee)
    if (authority?.role !== 'administrator') return
    const activeAdministrators = this.#activeAdministrators(worldId)
    if (activeAdministrators.length <= 1) {
      throw conflict(
        'last_world_administrator',
        '当前世界至少需要保留一名管理员，请先将另一名角色设为管理员。',
      )
    }
  }

  archiveEmployee(
    worldId: string,
    employeeId: string,
    actor: WorldAuthorityActor = { kind: 'owner', id: 'local-user' },
  ): EmployeeInstance {
    const employee = this.#requireActiveEmployee(worldId, employeeId)
    this.#assertActorMayArchive(worldId, employee, actor)
    this.assertCanArchiveEmployee(worldId, employeeId)
    const archived = this.#store.archiveEmployee(employeeId, actor.id)
    this.#store.syncWorldCompatibilityPrimaryAdministrator(worldId, this.#clock())
    return archived
  }

  #assertActorMayManage(
    worldId: string,
    target: EmployeeInstance,
    actor: WorldAuthorityActor,
    requestedPermissions: readonly WorldCharacterPermission[],
  ): void {
    if (actor.kind === 'owner') {
      if (!actor.id.trim()) throw forbidden('invalid_authority_actor', '权限操作缺少所有者身份')
      return
    }
    const actorEmployee = this.#store.getEmployee(actor.id)
    if (actorEmployee === undefined || actorEmployee.status === 'archived') {
      throw forbidden('authority_actor_unavailable', '权限操作角色不存在或已归档')
    }
    if (actorEmployee.worldId !== worldId || target.worldId !== worldId || actorEmployee.workspaceId !== target.workspaceId) {
      throw forbidden('cross_world_authority', '世界权限不能跨世界使用')
    }
    if (actorEmployee.id === target.id) {
      throw forbidden('authority_self_escalation', '角色不能修改自己的世界身份或权限')
    }
    const actorAuthority = this.#currentAuthority(worldId, actorEmployee)
    if (actorAuthority?.role !== 'administrator' || !actorAuthority.permissionGrants.includes('world.permissions.manage')) {
      throw forbidden('authority_delegation_denied', '只有拥有角色权限管理权的世界管理员才能委托权限')
    }
    for (const permission of requestedPermissions) {
      if (!actorAuthority.permissionGrants.includes(permission)) {
        throw forbidden(
          'authority_delegation_exceeds_grant',
          `不能委托角色自身没有的世界权限：${permission}`,
        )
      }
    }
  }

  #assertActorMayArchive(worldId: string, target: EmployeeInstance, actor: WorldAuthorityActor): void {
    if (actor.kind === 'owner') {
      if (!actor.id.trim()) throw forbidden('invalid_authority_actor', '权限操作缺少所有者身份')
      return
    }
    if (actor.id === target.id) throw forbidden('authority_self_escalation', '角色不能归档自己')
    const actorEmployee = this.#store.getEmployee(actor.id)
    if (actorEmployee?.worldId !== worldId) throw forbidden('cross_world_authority', '世界权限不能跨世界使用')
    this.assertPermission(worldId, actor.id, 'world.characters.manage')
  }

  #assertLastAdministratorInvariant(
    worldId: string,
    target: EmployeeInstance,
    current: WorldCharacterAuthority | undefined,
    nextRole: WorldCharacterRole,
  ): void {
    if (current?.role !== 'administrator' || nextRole === 'administrator') return
    const admins = this.#activeAdministrators(worldId)
    if (admins.length <= 1) {
      throw conflict(
        'last_world_administrator',
        '当前世界至少需要保留一名管理员，请先将另一名角色设为管理员。',
      )
    }
    // The target must be one of the active admins counted above. This guard
    // also protects against a stale projection being used for a downgrade.
    if (!admins.some((authority) => authority.employeeId === target.id)) {
      throw conflict('authority_projection_stale', '世界管理员状态已变化，请刷新后重试')
    }
  }

  #activeAdministrators(worldId: string): WorldCharacterAuthority[] {
    return this.#store
      .listActiveWorldCharacterAuthorities(worldId)
      .filter((authority) => authority.role === 'administrator')
  }

  #currentAuthority(worldId: string, employee: EmployeeInstance): WorldCharacterAuthority | undefined {
    const current = this.#store.getWorldCharacterAuthority(worldId, employee.id)
    if (current !== undefined) return current
    // This only supports a database opened from a pre-v21 snapshot by a host
    // that has not yet reopened it through SqliteStore migration. Normal
    // writes always create a row atomically with the employee.
    if (this.#store.getWorld(worldId)?.administratorEmployeeId === employee.id) {
      return {
        worldId,
        employeeId: employee.id,
        role: 'administrator',
        permissionGrants: [...RECOMMENDED_ADMIN_PERMISSIONS],
        createdAt: employee.createdAt,
        updatedAt: employee.updatedAt,
      }
    }
    return undefined
  }

  #requireActiveEmployee(worldId: string, employeeId: string): EmployeeInstance {
    const employee = this.#store.getEmployee(employeeId)
    if (employee === undefined) throw notFound('employee_not_found', '角色不存在')
    if (employee.worldId !== worldId) throw forbidden('cross_world_authority', '世界权限不能跨世界使用')
    if (employee.status === 'archived') throw conflict('employee_archived', '归档角色不能拥有世界管理权限')
    return employee
  }

}

function isKnownPermission(value: string): value is WorldCharacterPermission {
  return (WORLD_CHARACTER_PERMISSIONS as readonly string[]).includes(value)
}

function isManagementPermission(value: WorldCharacterPermission): boolean {
  return (WORLD_CHARACTER_MANAGEMENT_PERMISSIONS as readonly string[]).includes(value)
}

function normalizePermissions(values: readonly WorldCharacterPermission[]): WorldCharacterPermission[] {
  const unique = new Set<string>()
  for (const permission of values) {
    if (!isKnownPermission(permission)) throw invalid('unknown_world_permission', `未知世界权限：${permission}`)
    unique.add(permission)
  }
  const order = new Map<string, number>(WORLD_CHARACTER_PERMISSIONS.map((permission, index) => [permission, index]))
  return [...unique].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)) as WorldCharacterPermission[]
}

function assertRole(value: string): asserts value is WorldCharacterRole {
  if (value !== 'member' && value !== 'administrator') {
    throw invalid('unknown_world_role', `未知世界角色：${value}`)
  }
}

function samePermissions(left: readonly WorldCharacterPermission[], right: readonly WorldCharacterPermission[]): boolean {
  return left.length === right.length && left.every((permission, index) => permission === right[index])
}

function notFound(code: string, message: string): ServiceError {
  return new ServiceError('not-found', code, message)
}

function forbidden(code: string, message: string): ServiceError {
  return new ServiceError('forbidden', code, message)
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError('conflict', code, message)
}

function invalid(code: string, message: string): ServiceError {
  return new ServiceError('invalid', code, message)
}


export interface WorldAuthorityPatchInput {
  worldId: string
  targetEmployeeId: string
  actor: WorldAuthorityActor
  reason: string
  permissions: WorldCharacterPermission[]
  removePermissions?: WorldCharacterPermission[]
}

/**
 * A member was asked to hold a permission only administrators may hold.
 *
 * The caller decides what to do — the UI offers "promote and grant", the chat
 * path explains — but the answer is never a silent partial write.
 */
export class WorldAuthorityPromotionRequiredError extends Error {
  readonly code = 'requires_administrator_promotion'
  readonly permissions: readonly WorldCharacterPermission[]

  constructor(displayName: string, permissions: readonly WorldCharacterPermission[]) {
    super(`角色“${displayName}”需要先成为世界管理员才能持有：${permissions.join('、')}`)
    this.name = 'WorldAuthorityPromotionRequiredError'
    this.permissions = permissions
  }
}
