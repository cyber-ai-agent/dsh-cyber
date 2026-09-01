import { describe, expect, it } from 'vitest'

import type { WorldRendererCallbacks, WorldRuntimeSnapshot } from '@dsh-cyber/contracts'

import { createSpatialRendererRegistry } from '../src/features/world/extensions/spatial-3d/spatial-renderer-registry.js'
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
      id: 'employee-1', kind: 'agent', sceneId: 'scene-1', displayName: '小刘',
      position: { x, y: 0 }, footOffset: { x: 0, y: 0 }, facing: 'south',
      activity: 'idle', activityLabel: '待命', route: [], visualState: {},
      updatedAt: '2026-08-28T00:00:00.000Z',
    }],
    objects: [], growthSlots: {},
  } as unknown as WorldRuntimeSnapshot
}

describe('renderer ownership boundaries', () => {
  it('keeps 3d out of the core world registry', () => {
    const registry = createWorldRendererRegistry()
    expect(registry.supports('pixi-2d')).toBe(true)
    expect(registry.supports('three-3d')).toBe(false)
    expect(() => registry.create('three-3d', callbacks)).toThrow(/核心世界未提供渲染器/u)
  })

  it('provides 3d only from the optional spatial extension registry', () => {
    const locomotion = new WorldLocomotion()
    const registry = createSpatialRendererRegistry({ locomotion })
    expect(registry.supports('pixi-2d')).toBe(false)
    expect(registry.supports('three-3d')).toBe(true)
    const renderer = registry.create('three-3d', callbacks)
    expect(renderer).toBeInstanceOf(LazyThreeWorldRenderer)
    expect(renderer.kind).toBe('three-3d')
  })

  it('still refuses a renderer nobody installed', () => {
    expect(() => createWorldRendererRegistry().create('pixi-2.5d', callbacks)).toThrow()
  })

  it('lets core and extension observe the same locomotion store without sharing a registry', () => {
    const locomotion = new WorldLocomotion()
    const core = createWorldRendererRegistry({ locomotion }).create('pixi-2d', callbacks)
    const spatial = createSpatialRendererRegistry({ locomotion }).create('three-3d', callbacks)
    expect(core.kind).toBe('pixi-2d')
    expect(spatial.kind).toBe('three-3d')
  })
})

describe('the optional 3D shell before its module arrives', () => {
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

  it('tracks and clamps zoom while it waits', () => {
    const renderer = new LazyThreeWorldRenderer(callbacks)
    renderer.zoomBy(0.1)
    renderer.zoomBy(0.1)
    expect(renderer.getZoom()).toBeCloseTo(1.2, 6)
    for (let index = 0; index < 40; index += 1) renderer.zoomBy(0.1)
    expect(renderer.getZoom()).toBeLessThanOrEqual(2.2)
    for (let index = 0; index < 80; index += 1) renderer.zoomBy(-0.1)
    expect(renderer.getZoom()).toBeGreaterThanOrEqual(0.55)
    renderer.fitScene()
    expect(renderer.getZoom()).toBe(1)
  })

  it('drops queued work when the extension is closed mid-load and survives repeated destroy', () => {
    const renderer = new LazyThreeWorldRenderer(callbacks)
    renderer.updateSnapshot(snapshot(0))
    renderer.destroy()
    expect(() => renderer.updateSnapshot(snapshot(1))).not.toThrow()
    expect(() => renderer.destroy()).not.toThrow()
    expect(renderer.getZoom()).toBe(1)
  })
})

describe('shared locomotion remains core truth', () => {
  it('keeps a character where it was when an optional view opens', () => {
    const locomotion = new WorldLocomotion()
    locomotion.syncSnapshot(snapshot(0))
    locomotion.beginRoute('employee-1', [{ x: 0, y: 0 }, { x: 690, y: 0 }])
    locomotion.advance(1_000)
    const midWalk = locomotion.stateOf('employee-1')!

    expect(snapshot(0).entities[0]!.position.x).toBe(0)
    expect(midWalk.position.x).toBeGreaterThan(100)

    // Opening another renderer must read the store, not rewind it from the
    // stale server snapshot.
    locomotion.syncSnapshot(snapshot(0))
    expect(locomotion.stateOf('employee-1')!.position.x).toBeCloseTo(midWalk.position.x, 6)
  })
})
