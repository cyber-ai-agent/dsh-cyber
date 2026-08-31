import { describe, expect, it } from 'vitest'

import type { WorldRuntimeSnapshot } from '@dsh-cyber/contracts'

import { WorldLocomotion, WorldLocomotionClock, segmentDuration } from '../src/features/world/runtime/world-locomotion.js'

function snapshot(entities: Array<{ id: string; x: number; y: number }>): WorldRuntimeSnapshot {
  return {
    contractVersion: 1,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    templateId: 'cyber-company',
    themeId: 'theme-1',
    sceneId: 'scene-1',
    sequence: 1,
    generatedAt: '2026-08-28T00:00:00.000Z',
    clock: { now: '2026-08-28T00:00:00.000Z', timezone: 'Asia/Shanghai', lightsOn: true },
    entities: entities.map((entity) => ({
      id: entity.id,
      kind: 'agent' as const,
      sceneId: 'scene-1',
      displayName: entity.id,
      position: { x: entity.x, y: entity.y },
      footOffset: { x: 0, y: 0 },
      facing: 'south' as const,
      activity: 'idle' as const,
      activityLabel: '待命',
      route: [],
      visualState: {},
      updatedAt: '2026-08-28T00:00:00.000Z',
    })),
    objects: [],
    growthSlots: {},
  } as unknown as WorldRuntimeSnapshot
}

describe('WorldLocomotion', () => {
  it('adopts positions from a snapshot', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 100, y: 200 }]))
    expect(locomotion.stateOf('a')).toMatchObject({ position: { x: 100, y: 200 }, walking: false })
  })

  it('walks a straight route and stops exactly on the target', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 230, y: 0 }])

    locomotion.advance(500)
    const halfway = locomotion.stateOf('a')!
    expect(halfway.position.x).toBeCloseTo(115, 0)
    expect(halfway.walking).toBe(true)
    expect(halfway.facing).toBe('east')

    locomotion.advance(600)
    expect(locomotion.stateOf('a')).toMatchObject({ position: { x: 230, y: 0 }, walking: false })
  })

  it('carries a single tick across several segments', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 230, y: 0 }, { x: 230, y: 230 }])

    // A frame long enough to finish both legs must not stall at the corner:
    // a dropped frame or a background tab would otherwise leave a character
    // stuck partway through its route forever.
    locomotion.advance(5_000)
    expect(locomotion.stateOf('a')).toMatchObject({ position: { x: 230, y: 230 }, walking: false })
  })

  it('ignores the stale snapshot position of a character mid-walk', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 230, y: 0 }])
    locomotion.advance(500)

    // The server leaves entity.position at the pre-walk origin until a later
    // event settles the character, and it re-projects on every streamed token.
    // Adopting that position would drag the character backwards continuously.
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    expect(locomotion.stateOf('a')!.position.x).toBeCloseTo(115, 0)
  })

  it('accepts the settled position once the walk is over', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 230, y: 0 }])
    locomotion.advance(2_000)
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 230, y: 0 }]))
    expect(locomotion.stateOf('a')).toMatchObject({ position: { x: 230, y: 0 }, walking: false })
  })

  it('starts a new route from where the character actually is', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 460, y: 0 }])
    locomotion.advance(1_000)
    const interrupted = locomotion.stateOf('a')!.position.x
    expect(interrupted).toBeGreaterThan(0)

    // The server plans from the position it believes in. Honouring its first
    // point would snap the character back to the start of the old walk.
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 0, y: 460 }])
    expect(locomotion.stateOf('a')!.position.x).toBeCloseTo(interrupted, 5)
  })

  it('survives the renderer being replaced mid-walk', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 690, y: 0 }])
    locomotion.advance(1_000)
    const mid = locomotion.stateOf('a')!

    // This is the whole reason the store exists: switching 2D to 3D tears down
    // one renderer and builds another, and the only position the new one could
    // otherwise read is the stale snapshot origin.
    expect(mid.walking).toBe(true)
    expect(locomotion.walkingEntityIds()).toEqual(['a'])
    expect(locomotion.positionOf('a', { x: 0, y: 0 }).x).toBeCloseTo(mid.position.x, 5)

    locomotion.advance(3_000)
    expect(locomotion.stateOf('a')).toMatchObject({ position: { x: 690, y: 0 }, walking: false })
  })

  it('keeps advancing through an 800ms renderer swap gap', () => {
    const locomotion = new WorldLocomotion()
    const clock = new WorldLocomotionClock(locomotion)
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    locomotion.beginRoute('a', [{ x: 0, y: 0 }, { x: 690, y: 0 }])
    clock.tick(10_000)
    clock.tick(10_800)

    // The old renderer may be gone for the whole interval; the world clock is
    // still authoritative, so the new renderer takes over mid-stride.
    expect(locomotion.stateOf('a')!.position.x).toBeCloseTo(184, 0)
    expect(locomotion.stateOf('a')!.walking).toBe(true)
  })

  it('forgets characters a snapshot no longer contains', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 10 }]))
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 0, y: 0 }]))
    expect(locomotion.stateOf('b')).toBeUndefined()
  })

  it('refuses a route with nowhere to go', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot([{ id: 'a', x: 5, y: 5 }]))
    locomotion.beginRoute('a', [{ x: 5, y: 5 }])
    expect(locomotion.stateOf('a')).toMatchObject({ walking: false, position: { x: 5, y: 5 } })
  })

  it('gives a step a visible duration however short it is', () => {
    expect(segmentDuration({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(90)
    expect(segmentDuration({ x: 0, y: 0 }, { x: 230, y: 0 })).toBeCloseTo(1_000, 5)
  })
})
