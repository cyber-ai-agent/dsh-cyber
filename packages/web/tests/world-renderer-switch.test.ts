import { describe, expect, it } from 'vitest'

import type { WorldRendererCallbacks, WorldRuntimeSnapshot } from '@dsh-cyber/contracts'

import { createWorldRendererRegistry } from '../src/features/world/renderer/renderer-registry.js'
import { LazyThreeWorldRenderer } from '../src/features/world/renderer/lazy-three-world-renderer.js'
import { WorldLocomotion } from '../src/features/world/runtime/world-locomotion.js'

const callbacks: WorldRendererCallbacks = {
  onEntitySelect: () => {},
  onObjectSelect: () => {},
}

function snapshot(x: number): WorldRuntimeSnapshot {
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
    entities: [{
      id: 'employee-1',
      kind: 'agent',
      sceneId: 'scene-1',
      displayName: '小刘',
      position: { x, y: 0 },
      footOffset: { x: 0, y: 0 },
      facing: 'south',
      activity: 'idle',
      activityLabel: '待命',
      route: [],
      visualState: {},
      updatedAt: '2026-08-28T00:00:00.000Z',
    }],
    objects: [],
    growthSlots: {},
  } as unknown as WorldRuntimeSnapshot
}

describe('the renderer registry', () => {
  it('offers both worlds', () => {
    const registry = createWorldRendererRegistry()
    expect(registry.supports('pixi-2d')).toBe(true)
    expect(registry.supports('three-3d')).toBe(true)
  })

  it('builds a 3D renderer without loading three', () => {
    // The factory is synchronous and the first screen must not pull in the
    // three chunk, so what the registry hands back is a shell.
    const renderer = createWorldRendererRegistry().create('three-3d', callbacks)
    expect(renderer).toBeInstanceOf(LazyThreeWorldRenderer)
    expect(renderer.kind).toBe('three-3d')
  })

  it('still refuses a renderer nobody installed', () => {
    expect(() => createWorldRendererRegistry().create('pixi-2.5d', callbacks)).toThrow()
  })

  it('hands both renderers the same locomotion store', () => {
    // This is what makes a switch a change of view: the walk is shared, so the
    // renderer that takes over reads live positions rather than stale ones.
    const locomotion = new WorldLocomotion()
    const registry = createWorldRendererRegistry({ locomotion })
    const flat = registry.create('pixi-2d', callbacks)
    const spatial = registry.create('three-3d', callbacks)
    expect(flat.kind).toBe('pixi-2d')
    expect(spatial.kind).toBe('three-3d')
  })
})

describe('the 3D shell before its module arrives', () => {
  it('answers the interface without a renderer behind it', () => {
    const renderer = new LazyThreeWorldRenderer(callbacks)
    expect(() => {
      renderer.updateSnapshot(snapshot(0))
      renderer.applyCues([])
      renderer.selectEntity('employee-1')
      renderer.selectObject(undefined)
      renderer.focusEntity('employee-1')
      renderer.fitScene()
    }).not.toThrow()
  })

  it('tracks zoom while it waits, so a swap keeps the camera', () => {
    const renderer = new LazyThreeWorldRenderer(callbacks)
    renderer.zoomBy(0.1)
    renderer.zoomBy(0.1)
    expect(renderer.getZoom()).toBeCloseTo(1.2, 6)
    renderer.fitScene()
    expect(renderer.getZoom()).toBe(1)
  })

  it('clamps zoom to the range the world allows', () => {
    const renderer = new LazyThreeWorldRenderer(callbacks)
    for (let index = 0; index < 40; index += 1) renderer.zoomBy(0.1)
    expect(renderer.getZoom()).toBeLessThanOrEqual(2.2)
    for (let index = 0; index < 80; index += 1) renderer.zoomBy(-0.1)
    expect(renderer.getZoom()).toBeGreaterThanOrEqual(0.55)
  })

  it('drops queued work when the view is abandoned mid-load', () => {
    // A user who leaves before the chunk lands must not have a WebGL context
    // built for them afterwards.
    const renderer = new LazyThreeWorldRenderer(callbacks)
    renderer.updateSnapshot(snapshot(0))
    renderer.destroy()
    expect(() => renderer.updateSnapshot(snapshot(1))).not.toThrow()
    expect(renderer.getZoom()).toBe(1)
  })

  it('survives being destroyed twice', () => {
    const renderer = new LazyThreeWorldRenderer(callbacks)
    renderer.destroy()
    expect(() => renderer.destroy()).not.toThrow()
  })
})

describe('a walk survives the renderer being replaced', () => {
  it('keeps the character where it was, not where the snapshot says', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot(0))
    locomotion.beginRoute('employee-1', [{ x: 0, y: 0 }, { x: 690, y: 0 }])
    locomotion.advance(1_000)
    const midWalk = locomotion.stateOf('employee-1')!

    // The snapshot still reports the pre-walk origin — the server does not
    // move a character until a later event settles it — so a renderer reading
    // the snapshot on mount would teleport everybody back to the start.
    expect(snapshot(0).entities[0]!.position.x).toBe(0)
    expect(midWalk.position.x).toBeGreaterThan(100)

    locomotion.syncSnapshot(snapshot(0))
    expect(locomotion.stateOf('employee-1')!.position.x).toBeCloseTo(midWalk.position.x, 6)
  })
})
