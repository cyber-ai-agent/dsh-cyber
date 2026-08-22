import { describe, expect, it } from 'vitest'

import type {
  CharacterActionPlan,
  CharacterPresence,
  WorldSlotReservation,
} from '@dsh-cyber/contracts/world-simulation'
import type { AmbientCharacterState, AmbientSlot } from '@dsh-cyber/world-simulation'

import {
  RoleAwareAmbientLifeService,
  type AmbientLifePersistencePort,
} from '../src/services/role-aware-ambient-life-service.js'

class MemoryPersistence implements AmbientLifePersistencePort {
  readonly plans: CharacterActionPlan[] = []
  readonly reservations: WorldSlotReservation[] = []
  readonly presences: CharacterPresence[] = []
  readonly released: string[] = []

  saveActionPlan(plan: CharacterActionPlan): CharacterActionPlan {
    this.plans.push(structuredClone(plan))
    return structuredClone(plan)
  }

  saveReservations(reservations: readonly WorldSlotReservation[]): void {
    this.reservations.push(...structuredClone(reservations))
  }

  savePresences(presences: readonly CharacterPresence[]): void {
    this.presences.push(...structuredClone(presences))
  }

  releasePlanReservations(planId: string): number {
    this.released.push(planId)
    return 0
  }
}

function character(overrides: Partial<AmbientCharacterState> = {}): AmbientCharacterState {
  return {
    worldId: 'world-1',
    characterId: 'engineer',
    displayName: '开发工程师',
    role: '开发工程师',
    status: 'available',
    sceneId: 'headquarters',
    facing: 'east',
    roleTags: ['engineering', 'coding'],
    preferredZoneTags: ['engineering'],
    currentZoneId: 'engineering',
    currentSlotId: 'engineering-home',
    homeSlotId: 'engineering-home',
    idleSince: '2026-08-22T09:00:00.000Z',
    ...overrides,
  }
}

const slots: AmbientSlot[] = [
  { id: 'engineering-home', zoneId: 'engineering', kind: 'home', tags: ['engineering', 'coding'] },
  { id: 'engineering-board', zoneId: 'engineering', kind: 'approach', tags: ['engineering', 'testing', 'work'] },
  { id: 'public-conversation', zoneId: 'public', kind: 'conversation', tags: ['conversation', 'public'] },
]

describe('RoleAwareAmbientLifeService', () => {
  it('persists bounded plans, reservations and presences in the same tick', async () => {
    const persistence = new MemoryPersistence()
    const service = new RoleAwareAmbientLifeService({
      stateProvider: {
        loadCharacters: () => [character()],
        loadSlots: () => slots,
      },
      persistence,
      clock: () => '2026-08-22T10:00:00.000Z',
      idFactory: (scope) => scope.replaceAll(':', '-'),
      defaultPolicy: {
        enabled: true,
        minimumIdleMs: 1,
        minimumAmbientIntervalMs: 1,
        breakAfterMs: 99_999_999,
        maximumPlansPerTick: 1,
      },
    })

    const result = await service.tick('world-1')
    expect(result.persistedPlanIds).toHaveLength(1)
    expect(persistence.plans).toHaveLength(1)
    expect(persistence.reservations).toHaveLength(1)
    expect(persistence.presences).toHaveLength(1)
    expect(persistence.reservations[0]).toMatchObject({
      worldId: 'world-1',
      characterId: 'engineer',
      status: 'reserved',
    })
    expect(persistence.presences[0]).toMatchObject({
      worldId: 'world-1',
      characterId: 'engineer',
      sceneId: 'headquarters',
      facing: 'east',
      activePlanId: persistence.plans[0]?.id,
    })
  })

  it('does not persist ambient work when the character owns a real task', async () => {
    const persistence = new MemoryPersistence()
    const service = new RoleAwareAmbientLifeService({
      stateProvider: {
        loadCharacters: () => [character({ activePlanId: 'real-task' })],
        loadSlots: () => slots,
      },
      persistence,
      clock: () => '2026-08-22T10:00:00.000Z',
      defaultPolicy: { enabled: true, minimumIdleMs: 1 },
    })

    const result = await service.tick('world-1')
    expect(result.plans).toEqual([])
    expect(persistence.plans).toEqual([])
    expect(persistence.reservations).toEqual([])
    expect(persistence.presences).toEqual([])
  })

  it('remains disabled by default so an upgrade cannot unexpectedly start autonomous movement', async () => {
    const persistence = new MemoryPersistence()
    const service = new RoleAwareAmbientLifeService({
      stateProvider: {
        loadCharacters: () => [character()],
        loadSlots: () => slots,
      },
      persistence,
      clock: () => '2026-08-22T10:00:00.000Z',
    })

    const result = await service.tick('world-1')
    expect(result.plans).toEqual([])
    expect(persistence.plans).toEqual([])
  })
})
