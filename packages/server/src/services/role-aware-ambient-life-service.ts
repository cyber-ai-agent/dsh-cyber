import type {
  CharacterActionPlan,
  CharacterPresence,
  WorldSlotReservation,
} from '@dsh-cyber/contracts/world-simulation'
import {
  coordinateAmbientLife,
  type AmbientCharacterState,
  type AmbientCoordinationResult,
  type AmbientSlot,
  type AmbientWorldPolicy,
} from '@dsh-cyber/world-simulation'

export interface AmbientLifeStateProvider {
  loadCharacters(worldId: string): Promise<AmbientCharacterState[]> | AmbientCharacterState[]
  loadSlots(worldId: string): Promise<AmbientSlot[]> | AmbientSlot[]
}

export interface AmbientLifePersistencePort {
  saveActionPlan(plan: CharacterActionPlan): CharacterActionPlan
  saveReservations(reservations: readonly WorldSlotReservation[]): void
  savePresences(presences: readonly CharacterPresence[]): void
  releasePlanReservations(planId: string): number
}

export interface AmbientLifeServiceOptions {
  stateProvider: AmbientLifeStateProvider
  persistence: AmbientLifePersistencePort
  defaultPolicy?: AmbientWorldPolicy
  idFactory?: (scope: string) => string
  clock?: () => string
}

export interface AmbientLifeTickResult extends AmbientCoordinationResult {
  worldId: string
  generatedAt: string
  persistedPlanIds: string[]
}

const DEFAULT_POLICY: AmbientWorldPolicy = {
  enabled: false,
  minimumIdleMs: 45_000,
  minimumAmbientIntervalMs: 180_000,
  socialCooldownMs: 900_000,
  breakAfterMs: 1_800_000,
  timeBucketMs: 300_000,
  maximumPlansPerTick: 3,
}

/**
 * Application boundary for one role-aware ambient tick.
 *
 * It deliberately does not own a timer. Scheduling belongs to the server
 * composition root, while this service remains deterministic and testable.
 */
export class RoleAwareAmbientLifeService {
  readonly #stateProvider: AmbientLifeStateProvider
  readonly #persistence: AmbientLifePersistencePort
  readonly #defaultPolicy: AmbientWorldPolicy
  readonly #idFactory: ((scope: string) => string) | undefined
  readonly #clock: () => string

  constructor(options: AmbientLifeServiceOptions) {
    this.#stateProvider = options.stateProvider
    this.#persistence = options.persistence
    this.#defaultPolicy = { ...DEFAULT_POLICY, ...options.defaultPolicy }
    this.#idFactory = options.idFactory
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  async tick(worldId: string, policy: Partial<AmbientWorldPolicy> = {}): Promise<AmbientLifeTickResult> {
    const normalizedWorldId = worldId.trim()
    if (!normalizedWorldId) throw new Error('Ambient world id cannot be empty')
    const generatedAt = new Date(this.#clock()).toISOString()
    const [characters, slots] = await Promise.all([
      this.#stateProvider.loadCharacters(normalizedWorldId),
      this.#stateProvider.loadSlots(normalizedWorldId),
    ])
    const effectivePolicy = { ...this.#defaultPolicy, ...policy }
    const coordination = coordinateAmbientLife({
      worldId: normalizedWorldId,
      now: generatedAt,
      characters,
      slots,
      policy: effectivePolicy,
      ...(this.#idFactory === undefined ? {} : { idFactory: this.#idFactory }),
    })

    const persistedPlanIds: string[] = []
    try {
      for (const plan of coordination.plans) {
        this.#persistence.saveActionPlan(plan)
        persistedPlanIds.push(plan.id)
      }
      const reservations = coordination.decisions.map((decision, index): WorldSlotReservation => {
        const plan = coordination.plans[index]
        if (plan === undefined) throw new Error('Ambient decision has no matching action plan')
        const expiresAt = new Date(Date.parse(generatedAt) + 120_000).toISOString()
        return {
          id: makeReservationId(plan.id, decision.targetSlotId),
          worldId: normalizedWorldId,
          slotId: decision.targetSlotId,
          characterId: decision.characterId,
          planId: plan.id,
          status: 'reserved',
          priority: decision.priority,
          reservedAt: generatedAt,
          expiresAt,
          updatedAt: generatedAt,
        }
      })
      if (reservations.length > 0) this.#persistence.saveReservations(reservations)

      const characterById = new Map(characters.map((character) => [character.characterId, character]))
      const presences = coordination.decisions.map((decision, index): CharacterPresence => {
        const character = characterById.get(decision.characterId)
        const plan = coordination.plans[index]
        if (character === undefined || plan === undefined) {
          throw new Error('Ambient decision references a missing character or plan')
        }
        return {
          worldId: normalizedWorldId,
          characterId: character.characterId,
          sceneId: character.sceneId,
          zoneId: character.currentZoneId,
          homeSlotId: character.homeSlotId,
          currentSlotId: character.currentSlotId,
          reservedSlotId: decision.targetSlotId,
          facing: character.facing,
          physicalState: character.currentSlotId === decision.targetSlotId ? 'at-home' : 'navigating',
          status: character.status,
          activePlanId: plan.id,
          updatedAt: generatedAt,
        }
      })
      if (presences.length > 0) this.#persistence.savePresences(presences)
    } catch (error) {
      for (const planId of persistedPlanIds) this.#persistence.releasePlanReservations(planId)
      throw error
    }

    return {
      worldId: normalizedWorldId,
      generatedAt,
      ...coordination,
      persistedPlanIds,
    }
  }
}

function makeReservationId(planId: string, slotId: string): string {
  return `${planId}:reservation:${slotId}`.slice(0, 240)
}
