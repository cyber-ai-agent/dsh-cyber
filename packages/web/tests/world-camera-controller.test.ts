import { describe, expect, it } from 'vitest'

import {
  EYE_HEIGHT,
  approachPose,
  focusPose,
  followPose,
  overviewPose,
  poseFor,
  poseSettled,
} from '../src/features/world/camera/world-camera-controller.js'

const FRAMING = { width: 33, depth: 21, aspect: 16 / 9, fov: Math.PI / 4 }

interface Vector { x: number; y: number; z: number }

function normalize(vector: Vector): Vector {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

function cross(left: Vector, right: Vector): Vector {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

function dot(left: Vector, right: Vector): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

describe('overview', () => {
  it('looks down at the floor from an angle, not from straight above', () => {
    const pose = overviewPose(FRAMING)
    expect(pose.position.y).toBeGreaterThan(0)
    expect(pose.position.z).toBeGreaterThan(0)
    expect(pose.target).toEqual({ x: 0, y: 0, z: 0 })
    // A 45 degree pitch has equal height and depth; straight down would have
    // no depth and would read as a floor plan rather than a place.
    expect(pose.position.y).toBeCloseTo(pose.position.z, 6)
  })

  it('pulls back for a bigger office instead of overflowing the view', () => {
    const near = overviewPose(FRAMING)
    const far = overviewPose({ ...FRAMING, width: 66, depth: 42 })
    expect(far.position.y).toBeGreaterThan(near.position.y)
  })

  it('pulls back for a narrow window', () => {
    const wide = overviewPose(FRAMING)
    const narrow = overviewPose({ ...FRAMING, aspect: 0.6 })
    // A portrait window sees less horizontally; the floor still has to fit.
    expect(narrow.position.y).toBeGreaterThan(wide.position.y)
  })

  it('contains the floor it was asked to frame, corners included', () => {
    const pose = overviewPose(FRAMING)
    // Checked per axis, the way a rectangular frustum actually clips. A single
    // 3D angle to the corner is a stricter test than the frustum applies — the
    // diagonal is allowed to exceed the vertical half-angle — and asserting it
    // would demand a camera further back than correctness requires.
    const forward = normalize({
      x: pose.target.x - pose.position.x,
      y: pose.target.y - pose.position.y,
      z: pose.target.z - pose.position.z,
    })
    const right = normalize(cross({ x: 0, y: 1, z: 0 }, forward))
    const up = cross(forward, right)
    const halfVertical = FRAMING.fov / 2
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * FRAMING.aspect)

    for (const corner of [
      { x: -FRAMING.width / 2, z: -FRAMING.depth / 2 },
      { x: FRAMING.width / 2, z: -FRAMING.depth / 2 },
      { x: -FRAMING.width / 2, z: FRAMING.depth / 2 },
      { x: FRAMING.width / 2, z: FRAMING.depth / 2 },
    ]) {
      const toCorner = { x: corner.x - pose.position.x, y: -pose.position.y, z: corner.z - pose.position.z }
      const depth = dot(toCorner, forward)
      expect(depth).toBeGreaterThan(0)
      expect(Math.abs(Math.atan2(dot(toCorner, right), depth))).toBeLessThanOrEqual(halfHorizontal)
      expect(Math.abs(Math.atan2(dot(toCorner, up), depth))).toBeLessThanOrEqual(halfVertical)
    }
  })
})

describe('focus', () => {
  const subject = { position: { x: 4, y: 0, z: -3 }, heading: 0 }

  it('stands at eye level rather than on the floor', () => {
    const pose = focusPose(subject)
    expect(pose.position.y).toBeGreaterThan(1.4)
    expect(pose.position.y).toBeLessThan(2.2)
    expect(pose.target.y).toBeCloseTo(EYE_HEIGHT * 0.86, 6)
  })

  it('comes round to the character front', () => {
    // Heading 0 faces -z, so the camera has to be on the -z side to see a face.
    const pose = focusPose(subject)
    expect(pose.position.z).toBeLessThan(subject.position.z)
  })

  it('looks at the character, wherever they are', () => {
    const pose = focusPose(subject)
    expect(pose.target.x).toBeCloseTo(subject.position.x, 6)
    expect(pose.target.z).toBeCloseTo(subject.position.z, 6)
  })

  it('keeps the room behind them rather than filling the frame', () => {
    const pose = focusPose(subject)
    const distance = Math.hypot(pose.position.x - subject.position.x, pose.position.z - subject.position.z)
    // Close enough to talk to, far enough that the office is still visible.
    // Framing a character against nothing is what this change exists to stop.
    expect(distance).toBeGreaterThan(1.8)
    expect(distance).toBeLessThan(4)
  })
})

describe('follow', () => {
  const subject = { position: { x: 0, y: 0, z: 0 }, heading: 0 }

  it('sits behind and above, so the way ahead is visible', () => {
    const pose = followPose(subject)
    expect(pose.position.z).toBeGreaterThan(0)
    expect(pose.position.y).toBeGreaterThan(focusPose(subject).position.y)
  })

  it('stands further back than focus', () => {
    const near = Math.hypot(focusPose(subject).position.x, focusPose(subject).position.z)
    const far = Math.hypot(followPose(subject).position.x, followPose(subject).position.z)
    expect(far).toBeGreaterThan(near)
  })
})

describe('poseFor', () => {
  it('returns the whole company when there is nobody to look at', () => {
    // A camera pointed at a character who left the world would stare at floor.
    expect(poseFor({ mode: 'focus', overview: FRAMING })).toEqual(overviewPose(FRAMING))
    expect(poseFor({ mode: 'follow', overview: FRAMING })).toEqual(overviewPose(FRAMING))
  })

  it('picks the pose for the mode', () => {
    const subject = { position: { x: 1, y: 0, z: 1 }, heading: 0 }
    expect(poseFor({ mode: 'focus', overview: FRAMING, subject })).toEqual(focusPose(subject))
    expect(poseFor({ mode: 'follow', overview: FRAMING, subject })).toEqual(followPose(subject))
    expect(poseFor({ mode: 'overview', overview: FRAMING, subject })).toEqual(overviewPose(FRAMING))
  })
})

describe('approachPose', () => {
  const from = { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } }
  const to = { position: { x: 10, y: 10, z: 10 }, target: { x: 2, y: 2, z: 2 } }

  it('moves toward the target without arriving instantly', () => {
    const stepped = approachPose(from, to, 0.9, 16)
    expect(stepped.position.x).toBeGreaterThan(0)
    expect(stepped.position.x).toBeLessThan(10)
  })

  it('settles at the same rate whatever the framerate', () => {
    // One 100ms frame must land where ten 10ms frames land, or a camera move
    // becomes a different move on a slower machine.
    let stepwise = from
    for (let index = 0; index < 10; index += 1) stepwise = approachPose(stepwise, to, 0.9, 10)
    const single = approachPose(from, to, 0.9, 100)
    expect(stepwise.position.x).toBeCloseTo(single.position.x, 6)
  })

  it('converges', () => {
    let pose = from
    for (let index = 0; index < 400; index += 1) pose = approachPose(pose, to, 0.9, 16)
    expect(poseSettled(pose, to)).toBe(true)
  })

  it('stays put across a zero-length frame', () => {
    expect(approachPose(from, to, 0.9, 0)).toEqual(from)
  })

  it('reports an unfinished move as unsettled', () => {
    expect(poseSettled(from, to)).toBe(false)
  })
})
