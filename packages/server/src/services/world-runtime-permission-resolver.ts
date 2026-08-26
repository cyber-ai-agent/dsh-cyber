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
   * An explicit owner grant for the current conversation session.
   *
   * Never derived from a World Permission or a stored setting: administrator
   * rights administrate a world, not the machine.
   */
  ownerHostAccess?: boolean
}

/**
 * Resolves the DSH conversation sandbox and the character's world workspace.
 * The conversation permission controls DSH tools. World authority controls
 * which workspace directory the character receives by default.
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
    const fileAccess: WorldFileAccess = canWrite ? 'write' : canRead ? 'read' : 'none'
    const permissionMode: AgentPermissionMode = requested === 'danger-full-access'
      // Full host access is reachable only through an explicit current-session
      // owner grant. The grant itself is already bound to world, session and
      // character IDs before this resolver is called.
      ? input.ownerHostAccess === true
        ? 'danger-full-access'
        : 'read-only'
      : requested
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
