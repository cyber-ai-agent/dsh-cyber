import type { World } from '@dsh-cyber/contracts'
import type { ActiveWorldWork, SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from './service-error.js'
import type { WorldRootService } from './world-root-service.js'

export interface WorldLifecycleServiceOptions {
  store: SqliteStore
  roots: WorldRootService
}

export interface DeleteWorldResult {
  world: World
  /** Whether the WorldRoot directory was removed from disk. */
  filesRemoved: boolean
}

/**
 * Owner-facing archive, restore and permanent deletion of a world.
 *
 * Archiving is reversible and destroys nothing. Deletion is not reversible and
 * therefore fails closed twice over: the owner must re-type the world name, and
 * the world must have no work in flight.
 */
export class WorldLifecycleService {
  readonly #store: SqliteStore
  readonly #roots: WorldRootService

  constructor(options: WorldLifecycleServiceOptions) {
    this.#store = options.store
    this.#roots = options.roots
  }

  list(workspaceId: string, scope: 'active' | 'archived' | 'all' = 'active'): World[] {
    const all = this.#store.listWorlds(workspaceId, true)
    if (scope === 'all') return all
    return all.filter((world) => scope === 'archived' ? world.status === 'archived' : world.status === 'active')
  }

  archive(worldId: string): World {
    const world = this.#require(worldId)
    if (world.status === 'archived') {
      throw new ServiceError('conflict', 'world_already_archived', '这个世界已经归档了。')
    }
    return this.#store.archiveWorld({ worldId: world.id, actorId: 'owner', actorKind: 'owner' })
  }

  restore(worldId: string): World {
    const world = this.#require(worldId)
    if (world.status === 'active') {
      throw new ServiceError('conflict', 'world_not_archived', '这个世界没有归档，无需恢复。')
    }
    return this.#store.restoreWorld({ worldId: world.id, actorId: 'owner', actorKind: 'owner' })
  }

  /**
   * Permanently deletes a world.
   *
   * Order matters and is the whole crash-compensation story:
   *  1. refuse unless the typed name matches and no work is in flight;
   *  2. mark the WorldRoot pending-delete on disk;
   *  3. delete the database records in one transaction;
   *  4. remove the WorldRoot.
   *
   * A crash before (3) leaves the world fully intact and usable — only a stray
   * marker file remains, and the sweep ignores it because the world still
   * exists. A crash between (3) and (4) leaves an unreferenced marked
   * directory, which `sweepInterrupted` removes on the next start. The
   * application is usable after a crash at every point.
   */
  async delete(worldId: string, confirmationName: string): Promise<DeleteWorldResult> {
    const world = this.#require(worldId)
    if (confirmationName.trim() !== world.name) {
      throw new ServiceError(
        'invalid',
        'world_name_confirmation_mismatch',
        `请准确输入世界名称「${world.name}」以确认永久删除。`,
      )
    }
    const blocking = this.#store.listActiveWorldWork(world.id)
    if (blocking.length > 0) {
      throw new ServiceError('conflict', 'world_has_active_work', activeWorkMessage(blocking))
    }

    await this.#roots.markPendingDelete(world.id)
    try {
      this.#store.deleteWorld({
        worldId: world.id,
        confirmationName,
        actorId: 'owner',
        actorKind: 'owner',
      })
    } catch (error) {
      // Nothing was committed; withdraw the intent so a later sweep can never
      // act on a world that is still very much alive.
      await this.#roots.clearPendingDelete(world.id).catch(() => undefined)
      throw error
    }
    await this.#roots.remove(world.id)
    return { world, filesRemoved: true }
  }

  /** Completes deletions interrupted by a crash. Safe to call on every start. */
  async sweepInterrupted(): Promise<string[]> {
    const surviving = this.#store.listWorkspaces()
      .flatMap((workspace) => this.#store.listWorlds(workspace.id, true))
      .map((world) => world.id)
    return this.#roots.sweepPendingDeletes(surviving)
  }

  #require(worldId: string): World {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new ServiceError('not-found', 'world_not_found', '世界不存在。')
    return world
  }
}

function activeWorkMessage(blocking: readonly ActiveWorldWork[]): string {
  const turns = blocking.filter((item) => item.kind === 'work-turn').length
  const runs = blocking.filter((item) => item.kind === 'agent-run').length
  const parts: string[] = []
  if (turns > 0) parts.push(`${turns} 个进行中的任务轮次`)
  if (runs > 0) parts.push(`${runs} 个进行中的角色运行`)
  return `这个世界还有${parts.join('、')}，请先停止或等待它们结束，再永久删除。`
}
