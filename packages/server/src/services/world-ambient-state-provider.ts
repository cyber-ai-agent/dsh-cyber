import type { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'
import {
  resolveCharacterBehavior,
  type AmbientCharacterState,
  type AmbientSlot,
} from '@dsh-cyber/world-simulation'

import { resolveConfiguredCharacterBehavior } from './character-behavior-resolver.js'
import type { AmbientLifeStateProvider } from './role-aware-ambient-life-service.js'

export type AmbientSlotResolver = (worldId: string) => Promise<AmbientSlot[]> | AmbientSlot[]

export interface WorldAmbientStateProviderOptions {
  store: SqliteStore
  simulationStore: WorldSimulationStore
  resolveSlots: AmbientSlotResolver
}

/**
 * Reads the durable identity and presence of each character. It does not invent
 * coordinates or inspect renderer state. Themes provide semantic slots through
 * the resolver while SQLite remains authoritative for activity and cooldowns.
 */
export class WorldAmbientStateProvider implements AmbientLifeStateProvider {
  readonly #store: SqliteStore
  readonly #simulationStore: WorldSimulationStore
  readonly #resolveSlots: AmbientSlotResolver

  constructor(options: WorldAmbientStateProviderOptions) {
    this.#store = options.store
    this.#simulationStore = options.simulationStore
    this.#resolveSlots = options.resolveSlots
  }

  loadCharacters(worldId: string): AmbientCharacterState[] {
    const presences = new Map(
      this.#simulationStore.listPresences(worldId).map((presence) => [presence.characterId, presence]),
    )
    return this.#store
      .listEmployees(worldId)
      .filter((character) => character.status !== 'archived')
      .map((character) => {
        const presence = presences.get(character.id)
        if (presence === undefined) return undefined
        const plans = this.#simulationStore.listActionPlans(worldId, character.id)
        const latestAmbient = [...plans]
          .filter((plan) => plan.source === 'ambient' || plan.source === 'role-routine')
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        const configured = resolveConfiguredCharacterBehavior(this.#store, character)
        const behavior = resolveCharacterBehavior(character, configured)
        const state: AmbientCharacterState = {
          worldId,
          characterId: character.id,
          displayName: character.displayName,
          role: character.role,
          status: character.status,
          sceneId: presence.sceneId,
          facing: presence.facing,
          roleTags: [...behavior.roleTags],
          preferredZoneTags: [...behavior.preferredZoneTags],
          currentZoneId: presence.zoneId,
          currentSlotId: presence.currentSlotId,
          homeSlotId: presence.homeSlotId,
          idleSince: presence.updatedAt,
        }
        if (presence.activePlanId !== undefined) state.activePlanId = presence.activePlanId
        if (presence.activeSessionId !== undefined) state.activeSessionId = presence.activeSessionId
        if (latestAmbient !== undefined) state.lastAmbientAt = latestAmbient.createdAt
        return state
      })
      .filter((value): value is AmbientCharacterState => value !== undefined)
  }

  async loadSlots(worldId: string): Promise<AmbientSlot[]> {
    const [slots, reservations, presences] = await Promise.all([
      this.#resolveSlots(worldId),
      Promise.resolve(this.#simulationStore.listReservations(worldId)),
      Promise.resolve(this.#simulationStore.listPresences(worldId)),
    ])
    const reservedBy = new Map(reservations.map((reservation) => [reservation.slotId, reservation.characterId]))
    const occupiedBy = new Map(presences.map((presence) => [presence.currentSlotId, presence.characterId]))
    return slots.map((slot) => {
      const occupiedCharacterId = occupiedBy.get(slot.id)
      const reservedCharacterId = reservedBy.get(slot.id)
      return {
        ...slot,
        ...(occupiedCharacterId === undefined ? {} : { occupiedBy: occupiedCharacterId }),
        ...(reservedCharacterId === undefined ? {} : { reservedBy: reservedCharacterId }),
      }
    })
  }
}
