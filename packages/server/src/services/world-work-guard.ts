import type { World } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'

/**
 * The HTTP-facing half of the archived-world fail-closed rule.
 *
 * `SqliteStore` refuses to create a WorkTurn, an AgentRun or a queue entry in
 * an archived world, which is the backstop. This helper exists so every entry
 * point that could start work answers with the same actionable 409 instead of
 * an opaque 500 from the persistence layer.
 */
export function requireWorldAcceptingWork(store: SqliteStore, worldId: string): World {
  const world = store.getWorld(worldId)
  if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
  return assertWorldAcceptsWork(world)
}

export function assertWorldAcceptsWork(world: World): World {
  if (world.status === 'archived') {
    throw new HttpError(
      409,
      'world_archived',
      `世界「${world.name}」已归档，无法开始新的工作。请先恢复该世界。`,
    )
  }
  return world
}
