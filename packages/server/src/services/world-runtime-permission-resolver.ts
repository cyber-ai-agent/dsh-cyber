import type { AgentPermissionMode, WorldCharacterPermission } from '@dsh-cyber/contracts'

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
 *
 * The role's three-level runtime permission decides what a turn may do. On top
 * of that, a World Permission the owner has explicitly **revoked** is enforced:
 * revoking 读取当前世界文件 was recorded, audited and reported as done while the
 * runtime kept receiving the world's real files, which made the control a lie.
 *
 * Only a revocation counts, never a missing grant. Characters have been
 * recruited with an empty grant set all along, so absence means nobody ever
 * said anything about files — treating it as a denial would lock every
 * existing character out of its own world on the first start after upgrading.
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
    const readDenied = await this.#denied(input.worldId, input.employeeId, 'world.files.read')
    const writeDenied = readDenied || await this.#denied(input.worldId, input.employeeId, 'world.files.write')

    const fileAccess: WorldFileAccess = readDenied
      ? 'none'
      : writeDenied || requested === 'read-only' ? 'read' : 'write'
    // A revoked read is the owner's own decision about this world's files, and
    // it is not overridden by a host-access grant: the way to undo it is to
    // grant the permission back, not to escalate around it.
    // A write revocation is just as specific as a read revocation. Leaving a
    // confirmed danger-full-access lane active here would let the runtime
    // write the same world directory by absolute path, making the visible
    // world.files.write revocation ineffective.
    const permissionMode: AgentPermissionMode = readDenied || writeDenied
      ? 'read-only'
      : requested === 'danger-full-access'
        ? input.ownerHostAccess === true ? 'danger-full-access' : 'read-only'
        : requested === 'workspace-write' && !writeDenied ? 'workspace-write' : 'read-only'
    // Without world.files.read the runtime is anchored at an empty
    // host-managed workspace instead of the world's real files. Handing both
    // cases the same directory is what made the permission inert.
    const workspacePath = fileAccess === 'none' ? root.restrictedFilesPath : root.filesPath
    return { worldId: input.worldId, employeeId: input.employeeId, fileAccess, permissionMode, workspacePath }
  }

  /**
   * A permission the owner took away and has not given back.
   *
   * Both halves matter: the ledger says a removal happened, and the current
   * grant list says whether it was later restored.
   */
  async #denied(worldId: string, employeeId: string, permission: WorldCharacterPermission): Promise<boolean> {
    if (this.#authority?.wasPermissionRevoked === undefined) return false
    if (await this.#authority.hasPermission(worldId, employeeId, permission)) return false
    return await this.#authority.wasPermissionRevoked(worldId, employeeId, permission)
  }

  async resolveForCharacter(input: ResolveWorldRuntimePermissionInput): Promise<WorldRuntimePermissionResolution> {
    return await this.resolve(input)
  }

  async workspacePath(worldId: string): Promise<string> {
    return (await this.#roots.ensure(worldId)).filesPath
  }
}
