import type { AgentPermissionMode } from '@dsh-cyber/contracts'

import type { WorldPermissionRequestService, WorldAuthorityPort } from './world-permission-request-service.js'
import type { WorldRootService } from './world-root-service.js'

/** What a character may do with this world's files. */
export type WorldFileAccess = 'none' | 'read' | 'write'

export interface WorldRuntimePermissionResolution {
  worldId: string
  employeeId: string
  fileAccess: WorldFileAccess
  permissionMode: AgentPermissionMode
  workspacePath: string
}

export interface ResolveWorldRuntimePermissionInput {
  worldId: string
  employeeId: string
  requestedMode?: AgentPermissionMode
  /**
   * A one-time host-access grant the owner issued for this exact turn.
   *
   * Never derived from a World Permission or a stored setting: administrator
   * rights administrate a world, not the machine.
   */
  ownerHostAccess?: boolean
}

/**
 * Resolves the effective DSH runtime sandbox from the world authority row.
 * This is intentionally provider-neutral and always anchors writes inside
 * `worlds/<worldId>/files`; a world character can never turn a settings value
 * into `danger-full-access`.
 */
export class WorldRuntimePermissionResolver {
  readonly #roots: WorldRootService
  readonly #authority: WorldAuthorityPort | undefined

  constructor(options: { roots: WorldRootService; authority?: WorldAuthorityPort; worldPermissions?: WorldPermissionRequestService }) {
    this.#roots = options.roots
    this.#authority = options.authority
  }

  async resolve(input: ResolveWorldRuntimePermissionInput): Promise<WorldRuntimePermissionResolution> {
    const root = await this.#roots.ensure(input.worldId)
    const requested = input.requestedMode ?? 'read-only'
    const canRead = this.#authority === undefined
      ? false
      : await this.#authority.hasPermission(input.worldId, input.employeeId, 'world.files.read')
    const canWrite = this.#authority === undefined
      ? false
      : await this.#authority.hasPermission(input.worldId, input.employeeId, 'world.files.write')
    // A character runtime is capped at workspace-write even when legacy
    // settings or an untrusted prompt asks for full host access.
    const fileAccess: WorldFileAccess = canWrite ? 'write' : canRead ? 'read' : 'none'
    const permissionMode: AgentPermissionMode = requested === 'danger-full-access'
      // Full host access is reachable only through an explicit, single-use
      // owner grant, and still requires the character to hold file write —
      // the grant lifts the host boundary, not the world one.
      ? input.ownerHostAccess === true && canWrite
        ? 'danger-full-access'
        : canWrite ? 'workspace-write' : 'read-only'
      : requested === 'workspace-write' && canWrite
      ? 'workspace-write'
      : 'read-only'
    // Without world.files.read the runtime is anchored at an empty
    // host-managed workspace instead of the world's real files. Handing both
    // cases the same directory is what made the permission inert: a character
    // that had never been granted it could still list, search and read.
    const workspacePath = fileAccess === 'none' ? root.restrictedFilesPath : root.filesPath
    return { worldId: input.worldId, employeeId: input.employeeId, fileAccess, permissionMode, workspacePath }
  }

  async resolveForCharacter(input: ResolveWorldRuntimePermissionInput): Promise<WorldRuntimePermissionResolution> {
    return await this.resolve(input)
  }

  async workspacePath(worldId: string): Promise<string> {
    return (await this.#roots.ensure(worldId)).filesPath
  }
}

