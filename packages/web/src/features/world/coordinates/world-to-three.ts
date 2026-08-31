import type { WorldFacing, WorldPoint, WorldRect } from '@dsh-cyber/contracts'

/**
 * The one mapping between the world's coordinates and a 3D scene.
 *
 * World positions are scene pixels in the theme's 2D image space — the shipped
 * company floor is 1792 x 1120 — and there is no third axis anywhere in the
 * runtime contract. Rather than invent a second set of positions for 3D, every
 * 3D placement is derived from the same `WorldPoint` the 2D renderer draws, so
 * a character standing at a desk in one renderer stands at that desk in the
 * other by construction rather than by synchronisation.
 *
 * Deliberately free of any `three` import. These are plain numbers: the module
 * is reachable from the main bundle, and three/three-vrm are kept out of it by
 * a build budget that only holds while every importer of `three` is lazy.
 */

/**
 * Metres per scene pixel.
 *
 * Anchored to the one real measurement the world has: `spreadPosition` in the
 * simulation lays workstation slots on an 86px grid, and desks in an open
 * office sit about 1.6m apart. Everything else follows from that, which puts
 * the company floor at roughly 33m x 21m — a plausible floor plate rather than
 * a number chosen to make a demo look right.
 */
export const WORLD_SLOT_GAP_PIXELS = 86
export const WORLD_SLOT_GAP_METRES = 1.6
export const WORLD_SCALE = WORLD_SLOT_GAP_METRES / WORLD_SLOT_GAP_PIXELS

/** A point in the 3D scene, in metres. The world's y becomes depth (z). */
export interface ScenePoint {
  x: number
  y: number
  z: number
}

/**
 * A world point on the floor.
 *
 * The scene is centred on the world's origin corner so the floor straddles the
 * origin: a camera framing the whole company then has nothing to offset.
 */
export function worldPointToScene(point: WorldPoint, floor?: WorldRect): ScenePoint {
  const centre = floorCentre(floor)
  return {
    x: (point.x - centre.x) * WORLD_SCALE,
    y: 0,
    z: (point.y - centre.y) * WORLD_SCALE,
  }
}

/** The inverse, for turning a 3D hit back into something the runtime speaks. */
export function scenePointToWorld(point: ScenePoint, floor?: WorldRect): WorldPoint {
  const centre = floorCentre(floor)
  return {
    x: point.x / WORLD_SCALE + centre.x,
    y: point.z / WORLD_SCALE + centre.y,
  }
}

/** Scene metres for a scene-pixel length. */
export function worldLengthToScene(pixels: number): number {
  return pixels * WORLD_SCALE
}

/**
 * A rectangle of the 2D scene as a footprint on the 3D floor.
 *
 * World rects are top-left anchored; a 3D footprint is described by its centre,
 * which is what a mesh wants.
 */
export function worldRectToSceneFootprint(rect: WorldRect, floor?: WorldRect): {
  centre: ScenePoint
  width: number
  depth: number
} {
  return {
    centre: worldPointToScene({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, floor),
    width: worldLengthToScene(rect.width),
    depth: worldLengthToScene(rect.height),
  }
}

/**
 * The heading a character faces, in radians about the up axis.
 *
 * World `facing` is cardinal and screen-relative: south is toward the viewer at
 * the bottom of the 2D scene, which is +z in the scene. A model authored facing
 * -z (the glTF convention) therefore needs south to be a half turn.
 */
export function facingToSceneRotation(facing: WorldFacing): number {
  switch (facing) {
    case 'north': return 0
    case 'east': return Math.PI / 2
    case 'south': return Math.PI
    case 'west': return -Math.PI / 2
  }
}

/**
 * The heading implied by walking from one point to another.
 *
 * Negating depth keeps this on the same convention as
 * {@link facingToSceneRotation}: rotation 0 faces -z, so walking south (+z)
 * is a half turn and not a zero one.
 */
export function headingBetween(from: WorldPoint, to: WorldPoint): number {
  const dx = to.x - from.x
  const dz = to.y - from.y
  if (dx === 0 && dz === 0) return Math.PI
  return Math.atan2(dx, -dz)
}

/** Turns toward a target heading the short way round, never the long way. */
export function approachHeading(current: number, target: number, factor: number): number {
  const difference = normalizeAngle(target - current)
  return current + difference * clamp(factor, 0, 1)
}

export function normalizeAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % (Math.PI * 2)
  return (wrapped < 0 ? wrapped + Math.PI * 2 : wrapped) - Math.PI
}

function floorCentre(floor: WorldRect | undefined): WorldPoint {
  if (floor === undefined) return { x: 0, y: 0 }
  return { x: floor.x + floor.width / 2, y: floor.y + floor.height / 2 }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
