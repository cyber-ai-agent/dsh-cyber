import { describe, expect, it } from 'vitest'

import {
  createAmbientActionPlan,
  decideAmbientBehavior,
  type AmbientCharacterState,
  type AmbientPolicyInput,
  type AmbientSlot,
} from '../src/index.js'

const now = '2026-08-22T08:00:00.000Z'

function character(overrides: Partial<AmbientCharacterState> = {}): AmbientCharacterState {
  return {
    worldId: 'world-1',
    characterId: 'character-engineer',
    displayName: '开发工程师',
    role: '开发工程师',
    status: 'available',
    sceneId: 'headquarters',
    facing: 'south',
    roleTags: ['engineering', 'coding'],
    preferredZoneTags: ['engineering'],
    currentZoneId: 'zone-engineering',
    currentSlotId: 'desk-engineer-1',
    homeSlotId: 'desk-engineer-1',
    idleSince: '2026-08-22T07:40:00.000Z',
    ...overrides,
  }
}

const slots: AmbientSlot[] = [
  {
    id: 'desk-engineer-1',
    zoneId: 'zone-engineering',
    kind: 'home',
    tags: ['engineering', 'coding', 'work'],
  },
  {
    id: 'board-engineering',
    zoneId: 'zone-engineering',
    kind: 'approach',
    tags: ['engineering', 'testing', 'work'],
  },
  {
    id: 'admin-schedule',
    zoneId: 'zone-administration',
    kind: 'operate',
    tags: ['administration', 'schedule'],
  },
  {
    id: 'conversation-public-1',
    zoneId: 'zone-public',
    kind: 'conversation',
    tags: ['conversation', 'public'],
  },
  {
    id: 'lounge-seat-1',
    zoneId: 'zone-lounge',
    kind: 'rest',
    tags: ['rest', 'lounge', 'seat'],
  },
]

function policy(overrides: Partial<AmbientPolicyInput> = {}): AmbientPolicyInput {
  return {
    now,
    character: character(),
    slots,
    enabled: true,
    minimumIdleMs: 1,
    minimumAmbientIntervalMs: 1,
    breakAfterMs: 99_999_999,
    timeBucketMs: 300_000,
    ...overrides,
  }
}

describe('role-aware ambient policy', () => {
  it('never schedules an ambient action while a real task or session is active', () => {
    expect(decideAmbientBehavior(policy({
      character: character({ activePlanId: 'plan-real-task' }),
    }))).toBeUndefined()
    expect(decideAmbientBehavior(policy({
      character: character({ activeSessionId: 'session-user-chat' }),
    }))).toBeUndefined()
    expect(decideAmbientBehavior(policy({
      character: character({ status: 'working' }),
    }))).toBeUndefined()
  })

  it('returns a character to its stable home slot before considering other routines', () => {
    const result = decideAmbientBehavior(policy({
      character: character({
        currentZoneId: 'zone-lounge',
        currentSlotId: 'lounge-seat-1',
      }),
    }))
    expect(result).toMatchObject({
      kind: 'return-home',
      targetSlotId: 'desk-engineer-1',
      source: 'role-routine',
      interruptible: true,
    })
  })

  it('keeps engineering routines inside engineering-compatible slots', () => {
    const result = decideAmbientBehavior(policy())
    expect(result).toBeDefined()
    if (result?.kind === 'inspect-work-area') {
      expect(result.targetSlotId).toBe('board-engineering')
      expect(result.targetSlotId).not.toBe('admin-schedule')
    } else {
      expect(result?.targetSlotId).toBe('desk-engineer-1')
    }
  })

  it('is deterministic for the same world state and time bucket', () => {
    const first = decideAmbientBehavior(policy())
    const second = decideAmbientBehavior(policy())
    expect(second).toEqual(first)
  })

  it('does not select occupied or reserved slots owned by another character', () => {
    const result = decideAmbientBehavior(policy({
      slots: slots.map((slot) => slot.id === 'board-engineering'
        ? { ...slot, occupiedBy: 'character-other' }
        : slot),
    }))
    expect(result?.targetSlotId).not.toBe('board-engineering')
  })

  it('only produces spatial routines and never fabricates a role conversation', () => {
    for (let offset = 0; offset < 30; offset += 1) {
      const candidate = new Date(Date.parse(now) + offset * 300_000).toISOString()
      const result = decideAmbientBehavior(policy({ now: candidate }))
      expect(['stay-at-post', 'inspect-work-area', 'take-short-break', 'return-home']).toContain(result?.kind)
    }
  })

  it('compiles decisions into durable interruptible action plans', () => {
    const decision = {
      characterId: 'character-engineer',
      kind: 'inspect-work-area' as const,
      source: 'role-routine' as const,
      reason: '岗位巡检',
      priority: 16,
      interruptible: true as const,
      targetSlotId: 'board-engineering',
      decisionKey: 'decision-1',
    }
    const plan = createAmbientActionPlan(decision, {
      worldId: 'world-1',
      now,
      idFactory: (scope) => scope.replaceAll(':', '-'),
    })
    expect(plan).toMatchObject({
      worldId: 'world-1',
      characterId: 'character-engineer',
      source: 'role-routine',
      status: 'queued',
      interruptible: true,
    })
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'reserve-slot',
      'navigate-to-slot',
      'play-activity',
      'wait',
      'release-slot',
    ])
  })
})
