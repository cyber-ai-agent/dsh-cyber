import type { EmployeeInstance } from '@dsh-cyber/contracts'
import type { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'
import type {
  CharacterActionPlan,
  CharacterPresence,
} from '@dsh-cyber/contracts/world-simulation'

import type { AmbientLifeTickResult } from './role-aware-ambient-life-service.js'

export interface AmbientLifeExecutorOptions {
  store: SqliteStore
  simulationStore: WorldSimulationStore
  maximumDurationMs?: number
  clock?: () => string
}

const DEFAULT_MAXIMUM_DURATION_MS = 45_000

/**
 * Bridges durable ambient plans into the existing world event stream.
 * The projector consumes these semantic events and remains solely responsible
 * for coordinates and animation. The executor never controls pixels.
 */
export class AmbientLifeExecutor {
  readonly #store: SqliteStore
  readonly #simulationStore: WorldSimulationStore
  readonly #maximumDurationMs: number
  readonly #clock: () => string

  constructor(options: AmbientLifeExecutorOptions) {
    this.#store = options.store
    this.#simulationStore = options.simulationStore
    this.#maximumDurationMs = options.maximumDurationMs ?? DEFAULT_MAXIMUM_DURATION_MS
    this.#clock = options.clock ?? (() => new Date().toISOString())
    if (!Number.isInteger(this.#maximumDurationMs) || this.#maximumDurationMs < 10_000 || this.#maximumDurationMs > 300_000) {
      throw new Error('Ambient maximum duration must be between 10 seconds and 5 minutes')
    }
  }

  start(result: AmbientLifeTickResult): string[] {
    const now = new Date(this.#clock()).toISOString()
    const eventIds: string[] = []
    for (const [index, plan] of result.plans.entries()) {
      const decision = result.decisions[index]
      if (decision === undefined) continue
      const character = this.#requireCharacter(result.worldId, plan.characterId)
      const running: CharacterActionPlan = {
        ...plan,
        status: 'running',
        startedAt: now,
        steps: plan.steps.map((step, stepIndex) => stepIndex === 0
          ? { ...step, status: 'completed', startedAt: now, completedAt: now }
          : stepIndex === 1
            ? { ...step, status: 'running', startedAt: now }
            : step),
      }
      this.#simulationStore.saveActionPlan(running)
      const event = this.#store.appendDomainEvent({
        workspaceId: character.workspaceId,
        worldId: character.worldId,
        type: 'world.interaction.requested',
        actorId: character.id,
        actorKind: 'employee',
        correlationId: plan.id,
        payload: {
          action: 'ambient-start',
          employeeId: character.id,
          characterId: character.id,
          planId: plan.id,
          source: decision.source,
          behaviorKind: decision.kind,
          targetSlotId: decision.targetSlotId,
          reason: decision.reason,
          ...(decision.targetCharacterId === undefined
            ? {}
            : { targetCharacterId: decision.targetCharacterId }),
        },
      })
      eventIds.push(event.id)
    }
    return eventIds
  }

  completeDue(worldId: string, now = this.#clock()): string[] {
    const nowIso = new Date(now).toISOString()
    const nowMs = Date.parse(nowIso)
    const candidates = this.#simulationStore
      .listActionPlans(worldId)
      .filter((plan) => plan.source === 'ambient' || plan.source === 'role-routine')
      .filter((plan) => plan.status === 'running' || plan.status === 'queued')
      .filter((plan) => nowMs - Date.parse(plan.startedAt ?? plan.createdAt) >= this.#maximumDurationMs)
    const eventIds: string[] = []
    for (const plan of candidates) {
      const character = this.#requireCharacter(worldId, plan.characterId)
      const completed: CharacterActionPlan = {
        ...plan,
        status: 'completed',
        completedAt: nowIso,
        steps: plan.steps.map((step) => step.status === 'cancelled' || step.status === 'failed'
          ? step
          : { ...step, status: 'completed', completedAt: nowIso }),
      }
      this.#simulationStore.saveActionPlan(completed)
      this.#simulationStore.releasePlanReservations(plan.id)
      const presence = this.#simulationStore.getPresence(character.id)
      if (presence !== undefined) {
        const {
          reservedSlotId: _reservedSlotId,
          activePlanId: _activePlanId,
          ...stablePresence
        } = presence
        const next: CharacterPresence = {
          ...stablePresence,
          physicalState: 'navigating',
          updatedAt: nowIso,
        }
        this.#simulationStore.savePresence(next)
      }
      const event = this.#store.appendDomainEvent({
        workspaceId: character.workspaceId,
        worldId: character.worldId,
        type: 'world.interaction.requested',
        actorId: character.id,
        actorKind: 'employee',
        correlationId: plan.id,
        payload: {
          action: 'ambient-complete',
          employeeId: character.id,
          characterId: character.id,
          planId: plan.id,
          source: plan.source,
        },
      })
      eventIds.push(event.id)
    }
    return eventIds
  }

  #requireCharacter(worldId: string, characterId: string): EmployeeInstance {
    const character = this.#store.getEmployee(characterId)
    if (character === undefined || character.worldId !== worldId || character.status === 'archived') {
      throw new Error(`Ambient character is unavailable: ${characterId}`)
    }
    return character
  }
}
