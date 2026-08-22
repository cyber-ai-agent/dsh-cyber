import { describe, expect, it } from 'vitest'

import { coordinateAmbientLife } from '../src/ambient-coordinator.js'
import type { AmbientCharacterState, AmbientSlot } from '../src/ambient-policy.js'

const now = '2026-08-22T10:00:00.000Z'

function character(id: string, role: string, homeSlotId: string, roleTags: string[]): AmbientCharacterState {
  return {
    worldId: 'world-1',
    characterId: id,
    displayName: id,
    role,
    status: 'available',
    sceneId: 'headquarters',
    facing: 'south',
    roleTags,
    preferredZoneTags: roleTags,
    currentZoneId: homeSlotId.split(':')[0]!,
    currentSlotId: homeSlotId,
    homeSlotId,
    idleSince: '2026-08-22T09:00:00.000Z',
  }
}

const slots: AmbientSlot[] = [
  { id: 'engineering:home:1', zoneId: 'engineering', kind: 'home', tags: ['engineering', 'coding'] },
  { id: 'engineering:home:2', zoneId: 'engineering', kind: 'home', tags: ['engineering', 'coding'] },
  { id: 'engineering:board:1', zoneId: 'engineering', kind: 'approach', tags: ['engineering', 'testing', 'work'] },
  { id: 'administration:home:1', zoneId: 'administration', kind: 'home', tags: ['administration', 'schedule'] },
  { id: 'administration:archive:1', zoneId: 'administration', kind: 'operate', tags: ['administration', 'archive'] },
  { id: 'public:conversation:1', zoneId: 'public', kind: 'conversation', tags: ['public', 'conversation'] },
  { id: 'lounge:rest:1', zoneId: 'lounge', kind: 'rest', tags: ['rest', 'lounge'] },
]

describe('ambient life coordinator', () => {
  it('never produces two plans for the same destination slot', () => {
    const result = coordinateAmbientLife({
      worldId: 'world-1',
      now,
      characters: [
        character('engineer-a', '开发工程师', 'engineering:home:1', ['engineering']),
        character('engineer-b', '开发工程师', 'engineering:home:2', ['engineering']),
      ],
      slots,
      policy: {
        enabled: true,
        minimumIdleMs: 1,
        minimumAmbientIntervalMs: 1,
        breakAfterMs: 99_999_999,
        maximumPlansPerTick: 2,
      },
      idFactory: (scope) => scope.replaceAll(':', '-'),
    })
    const targets = result.decisions.map((decision) => decision.targetSlotId)
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('uses stable character ordering and returns identical plans for identical input', () => {
    const input = {
      worldId: 'world-1',
      now,
      characters: [
        character('secretary', '行政秘书', 'administration:home:1', ['administration']),
        character('engineer', '开发工程师', 'engineering:home:1', ['engineering']),
      ],
      slots,
      policy: {
        enabled: true,
        minimumIdleMs: 1,
        minimumAmbientIntervalMs: 1,
        breakAfterMs: 99_999_999,
        maximumPlansPerTick: 2,
      },
      idFactory: (scope: string) => scope.replaceAll(':', '-'),
    }
    const first = coordinateAmbientLife(input)
    const second = coordinateAmbientLife({ ...input, characters: [...input.characters].reverse() })
    expect(second.decisions).toEqual(first.decisions)
    expect(second.plans).toEqual(first.plans)
  })

  it('does not schedule characters with real work or active conversations', () => {
    const working = character('engineer', '开发工程师', 'engineering:home:1', ['engineering'])
    working.activePlanId = 'real-plan'
    const talking = character('secretary', '行政秘书', 'administration:home:1', ['administration'])
    talking.activeSessionId = 'user-session'
    const result = coordinateAmbientLife({
      worldId: 'world-1',
      now,
      characters: [working, talking],
      slots,
      policy: { enabled: true, minimumIdleMs: 1 },
    })
    expect(result.plans).toEqual([])
    expect(result.skippedCharacterIds.sort()).toEqual(['engineer', 'secretary'])
  })

  it('honors the per-tick budget to prevent a busy and noisy world', () => {
    const result = coordinateAmbientLife({
      worldId: 'world-1',
      now,
      characters: [
        character('a', '开发工程师', 'engineering:home:1', ['engineering']),
        character('b', '开发工程师', 'engineering:home:2', ['engineering']),
        character('c', '行政秘书', 'administration:home:1', ['administration']),
      ],
      slots,
      policy: {
        enabled: true,
        minimumIdleMs: 1,
        minimumAmbientIntervalMs: 1,
        maximumPlansPerTick: 1,
      },
    })
    expect(result.plans).toHaveLength(1)
    expect(result.skippedCharacterIds).toHaveLength(2)
  })
})
