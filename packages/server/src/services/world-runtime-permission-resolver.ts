import type { AgentPermissionMode } from '@dsh-cyber/contracts'

import type { WorldPermissionRequestService, WorldAuthorityPort } from './world-permission-request-service.js'
import type { WorldRootService } from './world-root-service.js'

export interface WorldRuntimePermissionResolution {
  worldId: string
  employeeId: string
  permissionMode: AgentPermissionMode
  workspacePath: string
}

export interface ResolveWorldRuntimePermissionInput {
  worldId: string
  employeeId: string
  requestedMode?: AgentPermissionMode
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
    const permissionMode: AgentPermissionMode = requested === 'danger-full-access'
      ? canWrite ? 'workspace-write' : 'read-only'
      : requested === 'workspace-write' && canWrite
      ? 'workspace-write'
      : canRead ? 'read-only' : 'read-only'
    return { worldId: input.worldId, employeeId: input.employeeId, permissionMode, workspacePath: root.filesPath }
  }

  async resolveForCharacter(input: ResolveWorldRuntimePermissionInput): Promise<WorldRuntimePermissionResolution> {
    return await this.resolve(input)
  }

  async workspacePath(worldId: string): Promise<string> {
    return (await this.#roots.ensure(worldId)).filesPath
  }
}

