import { describe, expect, it } from 'vitest'

import type { WorldThemeSceneManifest } from '@dsh-cyber/contracts'

import { planWorldLayout, zoneKindFor } from '../src/features/world/renderer/spatial/three-world-layout.js'
import { WORLD_SCALE } from '../src/features/world/coordinates/world-to-three.js'

function scene(overrides: Partial<WorldThemeSceneManifest> = {}): WorldThemeSceneManifest {
  return {
    id: 'floor-1',
    displayName: '公司',
    size: { width: 1792, height: 1120 },
    cameraBounds: { x: 0, y: 0, width: 1792, height: 1120 },
    safeArea: { x: 40, y: 40, width: 1712, height: 1040 },
    layers: [],
    anchors: [
      { id: 'desk-a', position: { x: 400, y: 400 }, facing: 'south', capacity: 1, tags: ['work'] },
      { id: 'desk-b', position: { x: 560, y: 400 }, facing: 'south', capacity: 1, tags: ['work'] },
      { id: 'meeting-round', position: { x: 1200, y: 600 }, facing: 'north', capacity: 4, tags: ['meeting'] },
      { id: 'lounge', position: { x: 300, y: 950 }, facing: 'east', capacity: 2, tags: ['idle'] },
    ],
    navigation: { origin: { x: 0, y: 0 }, cellSize: 64, columns: 28, rows: 18, blocked: [] },
    interactables: [
      {
        id: 'round-table',
        kind: 'meeting-table',
        displayName: '圆桌',
        bounds: { x: 1100, y: 520, width: 300, height: 200 },
        approachAnchorIds: ['meeting-round'],
        actions: [{ id: 'start-meeting', label: '开会' }],
        zIndex: 100,
      },
      {
        id: 'board',
        kind: 'notice-board',
        displayName: '看板',
        bounds: { x: 100, y: 100, width: 180, height: 60 },
        approachAnchorIds: ['desk-a'],
        actions: [{ id: 'inspect', label: '查看' }],
        zIndex: 90,
      },
    ],
    growthSlots: [],
    ...overrides,
  } as WorldThemeSceneManifest
}

describe('planWorldLayout', () => {
  it('builds a floor the size of the world', () => {
    const layout = planWorldLayout(scene())
    expect(layout.floor.width).toBeCloseTo(1792 * WORLD_SCALE, 6)
    expect(layout.floor.depth).toBeCloseTo(1120 * WORLD_SCALE, 6)
    expect(layout.floor.centre).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('places every interactable and keeps it clickable', () => {
    const layout = planWorldLayout(scene())
    const table = layout.placements.find((item) => item.objectId === 'round-table')!
    // Hit testing has to route into the selection contract the world already
    // has, so a 3D mesh carries the runtime object id rather than a new one.
    expect(table.kind).toBe('meeting-table')
    expect(table.width).toBeCloseTo(300 * WORLD_SCALE, 6)
    expect(layout.placements.find((item) => item.objectId === 'board')?.kind).toBe('board')
  })

  it('gives a working anchor a desk and everybody a seat', () => {
    const layout = planWorldLayout(scene())
    expect(layout.placements.some((item) => item.id === 'desk:desk-a')).toBe(true)
    // A lounge anchor is somewhere to stand, not somewhere to work: furnishing
    // it with a desk nobody uses is how a generated room starts looking fake.
    expect(layout.placements.some((item) => item.id === 'desk:lounge')).toBe(false)
    expect(layout.placements.some((item) => item.id === 'seat:lounge')).toBe(true)
  })

  it('puts the desk in front of where the character sits', () => {
    const layout = planWorldLayout(scene())
    const seat = layout.placements.find((item) => item.id === 'seat:desk-a')!
    const desk = layout.placements.find((item) => item.id === 'desk:desk-a')!
    // desk-a faces south, so its desk is further along +z.
    expect(desk.centre.z).toBeGreaterThan(seat.centre.z)
    expect(desk.centre.x).toBeCloseTo(seat.centre.x, 6)
  })

  it('keeps furniture on the floor rather than buried in it', () => {
    const layout = planWorldLayout(scene())
    for (const placement of layout.placements) {
      expect(placement.height).toBeGreaterThan(0)
      expect(placement.centre.y).toBe(0)
    }
  })

  it('gives things believable heights', () => {
    const layout = planWorldLayout(scene())
    expect(layout.placements.find((item) => item.kind === 'desk')!.height).toBeCloseTo(0.74, 2)
    expect(layout.placements.find((item) => item.kind === 'seat')!.height).toBeCloseTo(0.45, 2)
    expect(layout.placements.find((item) => item.kind === 'board')!.height).toBeCloseTo(1.8, 2)
  })

  it('divides the floor the way the simulation divides it', () => {
    const layout = planWorldLayout(scene())
    const kinds = layout.zones.map((zone) => zone.kind)
    expect(kinds).toContain('work')
    expect(kinds).toContain('meeting')
    for (const zone of layout.zones) {
      expect(zone.width).toBeGreaterThan(0)
      expect(zone.depth).toBeGreaterThan(0)
    }
  })

  it('records where each anchor stands, facing where the anchor faces', () => {
    const layout = planWorldLayout(scene())
    const anchor = layout.anchors.get('meeting-round')!
    expect(anchor.position.y).toBe(0)
    expect(anchor.rotation).toBeCloseTo(0, 6)
    expect(layout.anchors.size).toBe(4)
  })

  it('survives a scene with nothing in it', () => {
    const empty = planWorldLayout(scene({ anchors: [], interactables: [] }))
    // A theme that declares no furniture still has to produce a room, not throw.
    expect(empty.placements).toEqual([])
    expect(empty.zones).toEqual([])
    expect(empty.floor.width).toBeGreaterThan(0)
  })
})

describe('zoneKindFor', () => {
  it('reads the same signals the simulation reads', () => {
    expect(zoneKindFor('meeting-bridge', [])).toBe('meeting')
    expect(zoneKindFor('desk-3', ['work'])).toBe('work')
    expect(zoneKindFor('lounge', ['rest'])).toBe('rest')
    expect(zoneKindFor('growth-slot', [])).toBe('growth')
    expect(zoneKindFor('reception', [])).toBe('reception')
  })

  it('falls back to work rather than to nothing', () => {
    expect(zoneKindFor('unknown-anchor', [])).toBe('work')
  })

  it('recognizes the creative, research, and server/tool office zones', () => {
    expect(zoneKindFor('creative-studio', [])).toBe('creative')
    expect(zoneKindFor('research-lab', [])).toBe('research')
    expect(zoneKindFor('server-ops', [])).toBe('server')
  })
})
