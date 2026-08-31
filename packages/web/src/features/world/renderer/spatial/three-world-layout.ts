import type { WorldThemeSceneManifest, WorldPoint, WorldRect } from '@dsh-cyber/contracts'

import {
  type ScenePoint,
  facingToSceneRotation,
  worldLengthToScene,
  worldPointToScene,
  worldRectToSceneFootprint,
} from '../../coordinates/world-to-three.js'

/**
 * The office, derived from the world the 2D renderer already draws.
 *
 * A theme describes itself in 2D: a floor size, anchors where characters
 * stand, interactables with pixel bounds, and a navigation grid marking what
 * cannot be walked through. That is enough to build a room, and nothing here
 * is authored separately for 3D.
 *
 * Two different things come out of that, and the difference matters. An
 * interactable is the same object in both renderers — same id, same bounds, so
 * clicking it means the same thing. A desk is not: the 2D scene paints its
 * furniture into a background image, so a 3D desk is inferred from the anchor
 * a character works at. It stands where that character stands, which is the
 * property that matters, but it is not the same desk.
 *
 * Themes may later carry an explicit 3D description; until one does, this is
 * the layout, not a placeholder for it.
 *
 * Deliberately free of any `three` import: it is plain geometry, which is what
 * makes it testable without a WebGL context and keeps three out of any bundle
 * that has not asked for it.
 */

export type ScenePropKind =
  | 'floor'
  | 'desk'
  | 'seat'
  | 'meeting-table'
  | 'board'
  | 'partition'
  | 'rug'

export interface ScenePlacement {
  id: string
  kind: ScenePropKind
  centre: ScenePoint
  width: number
  depth: number
  height: number
  /** Radians about the up axis. */
  rotation: number
  /**
   * The runtime object this placement can be clicked to select.
   *
   * Only set for things the world already treats as interactive, so hit
   * testing routes into the existing selection contract rather than inventing
   * a second one.
   */
  objectId?: string
}

export type SceneZoneKind = 'work' | 'meeting' | 'rest' | 'growth' | 'reception' | 'creative' | 'research' | 'server'

export interface SceneZone {
  id: string
  kind: SceneZoneKind
  centre: ScenePoint
  width: number
  depth: number
}

export interface SceneLayout {
  floor: { width: number; depth: number; centre: ScenePoint }
  placements: ScenePlacement[]
  zones: SceneZone[]
  /** Where a character stands, by anchor, for cameras and default poses. */
  anchors: Map<string, { position: ScenePoint; rotation: number }>
}

/** Real furniture heights, in metres. A room reads wrong when these do not. */
const DESK_HEIGHT = 0.74
const SEAT_HEIGHT = 0.45
const BOARD_HEIGHT = 1.8
const PARTITION_HEIGHT = 1.25
const TABLE_HEIGHT = 0.74
const RUG_HEIGHT = 0.012

/** A workstation footprint, in scene pixels, centred on its anchor. */
const DESK_FOOTPRINT = { width: 132, depth: 68 }
const SEAT_FOOTPRINT = { width: 46, depth: 46 }

export function planWorldLayout(scene: WorldThemeSceneManifest): SceneLayout {
  const floorRect: WorldRect = { x: 0, y: 0, width: scene.size.width, height: scene.size.height }
  const placements: ScenePlacement[] = []
  const anchors = new Map<string, { position: ScenePoint; rotation: number }>()

  for (const anchor of scene.anchors) {
    anchors.set(anchor.id, {
      position: worldPointToScene(anchor.position, floorRect),
      rotation: facingToSceneRotation(anchor.facing),
    })
  }

  // Interactables first: they are the room's real furniture, and their bounds
  // are authored rather than guessed.
  for (const interactable of scene.interactables) {
    const footprint = worldRectToSceneFootprint(interactable.bounds, floorRect)
    const kind = propKindFor(interactable.kind)
    placements.push({
      id: `object:${interactable.id}`,
      kind,
      centre: { ...footprint.centre, y: 0 },
      width: footprint.width,
      depth: footprint.depth,
      height: heightFor(kind),
      rotation: 0,
      objectId: interactable.id,
    })
  }

  // A desk for every anchor a character actually works at. Anchors that are
  // only somewhere to stand get a seat instead of furniture nobody uses.
  for (const anchor of scene.anchors) {
    const seated = anchor.tags.includes('work') || anchor.tags.includes('inspect')
    const centre = worldPointToScene(anchor.position, floorRect)
    const rotation = facingToSceneRotation(anchor.facing)
    if (seated) {
      placements.push({
        id: `desk:${anchor.id}`,
        kind: 'desk',
        centre: { ...offsetForward(anchor.position, anchor.facing, 52), y: 0 },
        width: worldLengthToScene(DESK_FOOTPRINT.width),
        depth: worldLengthToScene(DESK_FOOTPRINT.depth),
        height: DESK_HEIGHT,
        rotation,
      })
    }
    placements.push({
      id: `seat:${anchor.id}`,
      kind: 'seat',
      centre,
      width: worldLengthToScene(SEAT_FOOTPRINT.width),
      depth: worldLengthToScene(SEAT_FOOTPRINT.depth),
      height: SEAT_HEIGHT,
      rotation,
    })
  }

  function offsetForward(position: WorldPoint, facing: string, pixels: number): ScenePoint {
    const delta = facing === 'north' ? { x: 0, y: -pixels }
      : facing === 'south' ? { x: 0, y: pixels }
        : facing === 'east' ? { x: pixels, y: 0 }
          : { x: -pixels, y: 0 }
    return worldPointToScene({ x: position.x + delta.x, y: position.y + delta.y }, floorRect)
  }

  return {
    floor: {
      width: worldLengthToScene(scene.size.width),
      depth: worldLengthToScene(scene.size.height),
      centre: { x: 0, y: 0, z: 0 },
    },
    placements,
    zones: planZones(scene, floorRect),
    anchors,
  }
}

/**
 * Zones, inferred from the same signals the simulation reads.
 *
 * A theme cannot declare a zone: `compileWorldSemantics` sniffs anchor ids and
 * tags to decide what part of the office an anchor belongs to, and this reads
 * the same fields for the same purpose. The two vocabularies are close but not
 * identical — the simulation's zone kinds serve scheduling, these serve floor
 * colour — so this is a deliberate parallel, not a shared implementation, and
 * a disagreement between them would show up as a character meeting somewhere
 * the floor calls a desk.
 */
function planZones(scene: WorldThemeSceneManifest, floorRect: WorldRect): SceneZone[] {
  const grouped = new Map<SceneZoneKind, WorldPoint[]>()
  for (const anchor of scene.anchors) {
    const kind = zoneKindFor(anchor.id, anchor.tags)
    const points = grouped.get(kind) ?? []
    points.push(anchor.position)
    grouped.set(kind, points)
  }
  for (const interactable of scene.interactables) {
    if (interactable.kind !== 'meeting-table') continue
    const points = grouped.get('meeting') ?? []
    points.push({ x: interactable.bounds.x, y: interactable.bounds.y })
    points.push({
      x: interactable.bounds.x + interactable.bounds.width,
      y: interactable.bounds.y + interactable.bounds.height,
    })
    grouped.set('meeting', points)
  }

  const zones: SceneZone[] = []
  for (const [kind, points] of grouped) {
    if (points.length === 0) continue
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const padding = 90
    const rect: WorldRect = {
      x: Math.min(...xs) - padding,
      y: Math.min(...ys) - padding,
      width: Math.max(...xs) - Math.min(...xs) + padding * 2,
      height: Math.max(...ys) - Math.min(...ys) + padding * 2,
    }
    const footprint = worldRectToSceneFootprint(rect, floorRect)
    zones.push({ id: `zone-${kind}`, kind, centre: footprint.centre, width: footprint.width, depth: footprint.depth })
  }
  return zones
}

export function zoneKindFor(anchorId: string, tags: readonly string[]): SceneZoneKind {
  const haystack = `${anchorId} ${tags.join(' ')}`.toLowerCase()
  if (/meeting|bridge|会议|round/.test(haystack)) return 'meeting'
  if (/rest|lounge|cafe|休息|sofa/.test(haystack)) return 'rest'
  if (/creative|studio|design|创意|设计/.test(haystack)) return 'creative'
  if (/research|lab|science|研究|实验/.test(haystack)) return 'research'
  if (/server|tool|ops|infra|服务器|工具|运维/.test(haystack)) return 'server'
  if (/growth|skill|milestone|成长/.test(haystack)) return 'growth'
  if (/reception|lobby|entry|前台|door/.test(haystack)) return 'reception'
  return 'work'
}

function propKindFor(interactableKind: string): ScenePropKind {
  if (interactableKind === 'meeting-table') return 'meeting-table'
  if (interactableKind === 'notice-board') return 'board'
  if (interactableKind === 'image') return 'rug'
  return 'partition'
}

function heightFor(kind: ScenePropKind): number {
  switch (kind) {
    case 'desk': return DESK_HEIGHT
    case 'seat': return SEAT_HEIGHT
    case 'meeting-table': return TABLE_HEIGHT
    case 'board': return BOARD_HEIGHT
    case 'partition': return PARTITION_HEIGHT
    case 'rug': return RUG_HEIGHT
    case 'floor': return 0
  }
}
