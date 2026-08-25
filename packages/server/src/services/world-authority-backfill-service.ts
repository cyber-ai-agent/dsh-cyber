import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  RECOMMENDED_ADMIN_PERMISSIONS,
  type WorldCharacterAuthority,
  type WorldCharacterPermission,
} from '@dsh-cyber/contracts/world-authority'

import type { WorldAuthorityPort } from './world-permission-request-service.js'
import type { WorldRootService } from './world-root-service.js'

export interface WorldAuthorityBackfillWorld {
  id: string
  administratorEmployeeId?: string
}

export interface WorldAuthorityBackfillEmployee {
  id: string
  status?: string
}

export interface WorldAuthorityBackfillPort extends WorldAuthorityPort {
  listWorlds(workspaceId: string): WorldAuthorityBackfillWorld[] | Promise<WorldAuthorityBackfillWorld[]>
  listEmployees(worldId: string): WorldAuthorityBackfillEmployee[] | Promise<WorldAuthorityBackfillEmployee[]>
  listAuthorityChanges?(worldId: string, employeeId: string): unknown[] | Promise<unknown[]>
  saveAuthority?(authority: WorldCharacterAuthority): WorldCharacterAuthority | Promise<WorldCharacterAuthority>
}

export interface WorldAuthorityBackfillResult {
  scanned: number
  updated: number
  unchanged: number
}

/**
 * Idempotent server-bootstrap compatibility pass for databases created before
 * world authority was durable. It only touches rows with no authority-change
 * ledger (the migration-created initial state), so later user customizations
 * are never overwritten. Legacy `settings.json` controls the initial file
 * grant; danger-full-access is deliberately capped at workspace-write.
 */
export class WorldAuthorityBackfillService {
  readonly #authority: WorldAuthorityBackfillPort
  readonly #roots: WorldRootService
  readonly #clock: () => Date

  constructor(options: { authority: WorldAuthorityBackfillPort; roots: WorldRootService; clock?: () => Date }) {
    this.#authority = options.authority
    this.#roots = options.roots
    this.#clock = options.clock ?? (() => new Date())
  }

  async run(workspaceIds: readonly string[]): Promise<WorldAuthorityBackfillResult> {
    let scanned = 0
    let updated = 0
    let unchanged = 0
    for (const workspaceId of workspaceIds) {
      for (const world of await this.#authority.listWorlds(workspaceId)) {
        const mode = await this.#legacyPermissionMode(world.id)
        for (const employee of await this.#authority.listEmployees(world.id)) {
          if (employee.status === 'archived') continue
          scanned += 1
          const current = await this.#authority.get(world.id, employee.id)
          const changes = this.#authority.listAuthorityChanges === undefined
            ? undefined
            : await this.#authority.listAuthorityChanges(world.id, employee.id)
          if (current !== undefined && changes !== undefined && changes.length > 0) {
            unchanged += 1
            continue
          }
          const role = current?.role ?? (world.administratorEmployeeId === employee.id ? 'administrator' : 'member')
          const legacyGrants = role === 'administrator'
            ? [...RECOMMENDED_ADMIN_PERMISSIONS]
            : filePermissionsFor(mode)
          // A host may expose only the authority port and not its audit
          // ledger. In that case the initial migration shape is the only
          // safe proof that a row is still backfillable; preserve any
          // subsequent custom grant set rather than guessing from timestamps.
          const isLegacyInitialRow = current === undefined
            || (changes !== undefined && changes.length === 0)
            || (changes === undefined && role === 'member' && samePermissions(current.permissionGrants, ['world.files.read']))
            || (changes === undefined && role === 'administrator' && samePermissions(current.permissionGrants, RECOMMENDED_ADMIN_PERMISSIONS))
          if (!isLegacyInitialRow) {
            unchanged += 1
            continue
          }
          const grants = legacyGrants
          const desired: WorldCharacterAuthority = {
            worldId: world.id,
            employeeId: employee.id,
            role,
            permissionGrants: grants,
            createdAt: current?.createdAt ?? this.#clock().toISOString(),
            updatedAt: this.#clock().toISOString(),
          }
          if (current !== undefined && sameAuthority(current, desired)) {
            unchanged += 1
            continue
          }
          await this.#write(desired)
          updated += 1
        }
      }
    }
    return { scanned, updated, unchanged }
  }

  async #write(authority: WorldCharacterAuthority): Promise<void> {
    if (this.#authority.updateAuthority !== undefined) {
      await this.#authority.updateAuthority({
        worldId: authority.worldId,
        targetEmployeeId: authority.employeeId,
        actor: { kind: 'owner', id: 'system-bootstrap' },
        role: authority.role,
        permissionGrants: authority.permissionGrants,
        reason: '兼容旧版 WorldSettings.runtime.permissionMode 的幂等回填',
      })
      return
    }
    if (this.#authority.saveAuthority !== undefined) {
      await this.#authority.saveAuthority(authority)
      return
    }
    throw new Error('World authority backfill requires an authority writer')
  }

  async #legacyPermissionMode(worldId: string): Promise<'read-only' | 'workspace-write' | 'danger-full-access'> {
    const root = await this.#roots.ensure(worldId)
    try {
      const value = JSON.parse(await readFile(join(root.rootPath, 'settings.json'), 'utf8')) as {
        runtime?: { permissionMode?: unknown }
      }
      const mode = value.runtime?.permissionMode
      return mode === 'workspace-write' || mode === 'danger-full-access' || mode === 'read-only'
        ? mode
        : 'read-only'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return 'read-only'
    }
  }
}

export { WorldAuthorityBackfillService as WorldCharacterAuthorityBackfillService }

function filePermissionsFor(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): WorldCharacterPermission[] {
  return mode === 'workspace-write' || mode === 'danger-full-access'
    ? ['world.files.read', 'world.files.write']
    : ['world.files.read']
}

function sameAuthority(left: WorldCharacterAuthority, right: WorldCharacterAuthority): boolean {
  return left.role === right.role
    && left.permissionGrants.length === right.permissionGrants.length
    && left.permissionGrants.every((item, index) => item === right.permissionGrants[index])
}

function samePermissions(left: readonly WorldCharacterPermission[], right: readonly WorldCharacterPermission[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
