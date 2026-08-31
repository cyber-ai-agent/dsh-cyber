import { describe, expect, it } from 'vitest'

import {
  WORLD_SCALE,
  approachHeading,
  facingToSceneRotation,
  headingBetween,
  normalizeAngle,
  scenePointToWorld,
  worldLengthToScene,
  worldPointToScene,
  worldRectToSceneFootprint,
} from '../src/features/world/coordinates/world-to-three.js'

/** The shipped company floor. */
const FLOOR = { x: 0, y: 0, width: 1792, height: 1120 }

describe('world to scene coordinates', () => {
  it('puts the floor centre at the scene origin', () => {
    expect(worldPointToScene({ x: 896, y: 560 }, FLOOR)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('maps the world y axis to scene depth, never to height', () => {
    const point = worldPointToScene({ x: 896, y: 1120 }, FLOOR)
    expect(point.y).toBe(0)
    expect(point.z).toBeGreaterThan(0)
  })

  it('round-trips', () => {
    const original = { x: 421, y: 733 }
    const returned = scenePointToWorld(worldPointToScene(original, FLOOR), FLOOR)
    expect(returned.x).toBeCloseTo(original.x, 6)
    expect(returned.y).toBeCloseTo(original.y, 6)
  })

  it('gives the company floor a believable size', () => {
    // The scale is anchored to the simulation's own 86px slot grid reading as
    // 1.6m of desk spacing, so the floor plate has to come out as a room rather
    // than as a stadium or a tabletop.
    expect(worldLengthToScene(1792)).toBeGreaterThan(25)
    expect(worldLengthToScene(1792)).toBeLessThan(40)
    expect(worldLengthToScene(1120)).toBeGreaterThan(15)
    expect(worldLengthToScene(1120)).toBeLessThan(25)
  })

  it('keeps two adjacent workstation slots a desk apart', () => {
    expect(worldLengthToScene(86)).toBeCloseTo(1.6, 6)
  })

  it('centres a rect footprint rather than anchoring it top-left', () => {
    const footprint = worldRectToSceneFootprint({ x: 0, y: 0, width: 200, height: 100 }, FLOOR)
    expect(footprint.width).toBeCloseTo(200 * WORLD_SCALE, 6)
    expect(footprint.depth).toBeCloseTo(100 * WORLD_SCALE, 6)
    expect(footprint.centre).toEqual(worldPointToScene({ x: 100, y: 50 }, FLOOR))
  })

  it('works without a floor, for a scene that has not declared one', () => {
    expect(worldPointToScene({ x: 100, y: 200 })).toEqual({
      x: 100 * WORLD_SCALE,
      y: 0,
      z: 200 * WORLD_SCALE,
    })
  })
})

describe('facing and heading', () => {
  it('actually points a model the way the facing says', () => {
    // The previous tests only checked the two functions agreed with each
    // other, which they did — while both pointing east and west the wrong way.
    // A glTF model faces -z at rotation 0, so rotating it must land its
    // forward vector on the axis the facing names.
    const forward = (rotation: number) => ({
      x: -Math.sin(rotation),
      z: -Math.cos(rotation),
    })
    expect(forward(facingToSceneRotation('north')).z).toBeCloseTo(-1, 6)
    expect(forward(facingToSceneRotation('south')).z).toBeCloseTo(1, 6)
    expect(forward(facingToSceneRotation('east')).x).toBeCloseTo(1, 6)
    expect(forward(facingToSceneRotation('west')).x).toBeCloseTo(-1, 6)

    // And walking that way has to produce the same heading.
    expect(forward(headingBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).x).toBeCloseTo(1, 6)
    expect(forward(headingBetween({ x: 0, y: 0 }, { x: -10, y: 0 })).x).toBeCloseTo(-1, 6)
    expect(forward(headingBetween({ x: 0, y: 0 }, { x: 0, y: 10 })).z).toBeCloseTo(1, 6)
  })

  it('turns the cardinal facings into distinct headings', () => {
    const headings = (['north', 'east', 'south', 'west'] as const).map(facingToSceneRotation)
    expect(new Set(headings).size).toBe(4)
  })

  it('faces south toward the viewer', () => {
    // South is the bottom of the 2D scene, which is +z. A glTF model authored
    // facing -z therefore has to be turned around.
    expect(facingToSceneRotation('south')).toBeCloseTo(Math.PI, 6)
    expect(facingToSceneRotation('north')).toBeCloseTo(0, 6)
  })

  it('derives a heading from a walk', () => {
    // Compared as directions, not as numbers: a half turn is equally +pi and
    // -pi, and a test that cannot tell them apart fails on a correct result.
    const sameDirection = (left: number, right: number) =>
      expect(Math.abs(normalizeAngle(left - right))).toBeCloseTo(0, 6)
    sameDirection(headingBetween({ x: 0, y: 0 }, { x: 0, y: 10 }), facingToSceneRotation('south'))
    sameDirection(headingBetween({ x: 0, y: 0 }, { x: 10, y: 0 }), facingToSceneRotation('east'))
    sameDirection(headingBetween({ x: 0, y: 0 }, { x: -10, y: 0 }), facingToSceneRotation('west'))
    sameDirection(headingBetween({ x: 0, y: 0 }, { x: 0, y: -10 }), facingToSceneRotation('north'))
  })

  it('turns the short way round', () => {
    // Approaching -170 deg from 170 deg is a 20 deg turn, not a 340 deg spin.
    const from = Math.PI * 0.95
    const to = -Math.PI * 0.95
    const stepped = approachHeading(from, to, 0.5)
    expect(Math.abs(normalizeAngle(stepped - from))).toBeLessThan(Math.PI / 2)
  })

  it('reaches the target when asked to go all the way', () => {
    expect(normalizeAngle(approachHeading(1, -2, 1) - -2)).toBeCloseTo(0, 6)
  })

  it('stays put when asked for no turn', () => {
    expect(approachHeading(1, -2, 0)).toBeCloseTo(1, 6)
  })
})
