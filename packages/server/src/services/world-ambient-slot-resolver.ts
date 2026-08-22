import type { SqliteStore } from '@dsh-cyber/persistence'
import { cyberCompanyTheme } from '@dsh-cyber/world-runtime'
import {
  compileWorldSemantics,
  type AmbientSlot,
} from '@dsh-cyber/world-simulation'

import { ServiceError } from './service-error.js'

export interface AmbientThemeSlotResolverOptions {
  store: SqliteStore
}

/**
 * Resolves semantic slots without exposing coordinates to an LLM.
 *
 * The first release supports the built-in personal/company runtime. The port is
 * intentionally isolated so installed Theme V2 packages can provide their own
 * compiled semantics without changing ambient policy code.
 */
export class WorldAmbientSlotResolver {
  readonly #store: SqliteStore

  constructor(options: AmbientThemeSlotResolverOptions) {
    this.#store = options.store
  }

  resolve(worldId: string): AmbientSlot[] {
    const world = this.#store.getWorld(worldId)
    if (world === undefined || world.status === 'archived') {
      throw new ServiceError('not-found', 'world_not_found', '世界不存在或已归档', 404)
    }
    if (world.templateId !== 'personal-world' && world.templateId !== 'cyber-company') {
      return []
    }
    const semantics = compileWorldSemantics(cyberCompanyTheme)
    return semantics.slots.map((slot) => ({
      id: slot.id,
      zoneId: slot.zoneId,
      kind: ambientKind(slot.kind),
      tags: [...slot.tags],
    }))
  }
}

function ambientKind(value: string): AmbientSlot['kind'] {
  switch (value) {
    case 'home':
    case 'work':
    case 'approach':
    case 'seat':
    case 'operate':
    case 'conversation':
    case 'waiting':
    case 'rest':
      return value
    default:
      return 'waiting'
  }
}
