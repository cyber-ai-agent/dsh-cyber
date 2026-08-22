import type { EmployeeInstance } from '@dsh-cyber/contracts'
import type { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'
import type {
  AmbientCharacterState,
  AmbientSlot,
} from '@dsh-cyber/world-simulation'

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
    const episodes = this.#simulationStore.listSharedEpisodes(worldId)
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
        const latestSocial = episodes
          .filter((episode) => episode.participantIds.includes(character.id))
          .filter((episode) => episode.kind === 'conversation' || episode.kind === 'collaboration')
          .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0]
        const state: AmbientCharacterState = {
          worldId,
          characterId: character.id,
          displayName: character.displayName,
          role: character.role,
          status: character.status,
          roleTags: roleTags(character),
          preferredZoneTags: preferredZoneTags(character),
          currentZoneId: presence.zoneId,
          currentSlotId: presence.currentSlotId,
          homeSlotId: presence.homeSlotId,
          idleSince: presence.updatedAt,
        }
        if (presence.activePlanId !== undefined) state.activePlanId = presence.activePlanId
        if (presence.activeSessionId !== undefined) state.activeSessionId = presence.activeSessionId
        if (latestAmbient !== undefined) state.lastAmbientAt = latestAmbient.createdAt
        if (latestSocial !== undefined) state.lastSocialAt = latestSocial.occurredAt
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
    return slots.map((slot) => ({
      ...slot,
      ...(occupiedBy.get(slot.id) === undefined ? {} : { occupiedBy: occupiedBy.get(slot.id) }),
      ...(reservedBy.get(slot.id) === undefined ? {} : { reservedBy: reservedBy.get(slot.id) }),
    }))
  }
}

function roleTags(character: EmployeeInstance): string[] {
  const values = new Set<string>([character.role.trim().toLocaleLowerCase()])
  const signal = `${character.role} ${character.blueprintId}`.toLocaleLowerCase()
  if (/开发|工程|架构|测试|code|engineer|developer|qa/.test(signal)) {
    values.add('engineering')
    values.add('coding')
    values.add('testing')
  }
  if (/秘书|管家|行政|协调|助理|secretary|butler|assistant|admin/.test(signal)) {
    values.add('administration')
    values.add('coordination')
    values.add('schedule')
  }
  if (/研究|档案|知识|分析|research|archive|knowledge|analyst/.test(signal)) {
    values.add('research')
    values.add('knowledge')
    values.add('archive')
  }
  if (/运维|运营|监控|安全|operations|ops|monitor|security/.test(signal)) {
    values.add('operations')
    values.add('monitoring')
    values.add('control')
  }
  return [...values]
}

function preferredZoneTags(character: EmployeeInstance): string[] {
  const tags = roleTags(character)
  const preferred = tags.filter((tag) => [
    'engineering',
    'administration',
    'research',
    'operations',
  ].includes(tag))
  return preferred.length > 0 ? preferred : ['public']
}
