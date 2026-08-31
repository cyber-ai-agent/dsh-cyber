import type { ScenePoint } from '../coordinates/world-to-three.js'
import type { WorldCameraMode } from '../runtime/world-view-mode.js'

/**
 * Where the camera should be, for each way of looking at the world.
 *
 * Kept as arithmetic rather than as a Three object so the framing can be
 * tested without a WebGL context, and so the renderer's job is reduced to
 * moving a camera toward a pose somebody else decided on.
 *
 * The poses matter more than they look. `focus` deliberately keeps the office
 * behind the character instead of framing them against nothing: a character
 * cropped out of their world is the thing this whole change exists to stop.
 */

export interface CameraPose {
  position: ScenePoint
  target: ScenePoint
}

export interface OverviewFraming {
  width: number
  depth: number
  /** Viewport aspect, so a narrow window still contains the floor. */
  aspect: number
  /** Vertical field of view, in radians. */
  fov: number
}

/** A simulation-game angle: high enough to read the floor plan, low enough to have depth. */
const OVERVIEW_PITCH = Math.PI / 4
const OVERVIEW_MARGIN = 1.18

/**
 * The whole company, framed so the floor fits whatever window it is in.
 *
 * Distance is derived from the floor and the lens rather than fixed, so a
 * bigger office pulls the camera back instead of overflowing the view.
 */
export function overviewPose(framing: OverviewFraming): CameraPose {
  const distance = overviewDistance(framing)
  return {
    position: { x: 0, y: Math.sin(OVERVIEW_PITCH) * distance, z: Math.cos(OVERVIEW_PITCH) * distance },
    target: { x: 0, y: 0, z: 0 },
  }
}

/**
 * How far back the camera has to stand for the whole floor to be in shot.
 *
 * Solved against the four corners rather than against the floor's width and
 * depth. Seen from 45 degrees the near corners sit closer to the camera than
 * the centre does, so they subtend a wider angle: framing the floor as if it
 * were face-on is the calculation that cropped them.
 *
 * The angle every corner subtends shrinks monotonically with distance, so
 * doubling until it fits and then bisecting converges quickly and exactly,
 * without a closed form that would have to be re-derived for a different pitch.
 */
function overviewDistance(framing: OverviewFraming): number {
  const halfVertical = framing.fov / 2
  const halfHorizontal = horizontalFov(framing.fov, framing.aspect) / 2
  const corners = [
    { x: -framing.width / 2, z: -framing.depth / 2 },
    { x: framing.width / 2, z: -framing.depth / 2 },
    { x: -framing.width / 2, z: framing.depth / 2 },
    { x: framing.width / 2, z: framing.depth / 2 },
  ]

  const fits = (distance: number): boolean => {
    const eye = { x: 0, y: Math.sin(OVERVIEW_PITCH) * distance, z: Math.cos(OVERVIEW_PITCH) * distance }
    // The camera's own axes, from it looking at the origin.
    const forward = normalize({ x: -eye.x, y: -eye.y, z: -eye.z })
    const right = normalize(cross({ x: 0, y: 1, z: 0 }, forward))
    const up = cross(forward, right)
    return corners.every((corner) => {
      const toCorner = { x: corner.x - eye.x, y: -eye.y, z: corner.z - eye.z }
      const depth = dot(toCorner, forward)
      if (depth <= 0) return false
      return Math.abs(Math.atan2(dot(toCorner, right), depth)) <= halfHorizontal
        && Math.abs(Math.atan2(dot(toCorner, up), depth)) <= halfVertical
    })
  }

  const extent = Math.max(framing.width, framing.depth)
  let far = Math.max(extent, 1)
  for (let attempt = 0; attempt < 24 && !fits(far); attempt += 1) far *= 2
  let near = 0
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const middle = (near + far) / 2
    if (fits(middle)) far = middle
    else near = middle
  }
  return far * OVERVIEW_MARGIN
}

function normalize(vector: ScenePoint): ScenePoint {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length }
}

function cross(left: ScenePoint, right: ScenePoint): ScenePoint {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  }
}

function dot(left: ScenePoint, right: ScenePoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z
}

/** Eye level for an adult, in metres. Framing reads wrong from the floor. */
export const EYE_HEIGHT = 1.55

export interface FocusFraming {
  /** Where the character stands. */
  position: ScenePoint
  /** Which way they face, in radians about the up axis. */
  heading: number
  /** How far back to stand. Larger shows more of the room behind them. */
  distance?: number
}

/**
 * One character, still in their office.
 *
 * The camera comes round to the character's front — you talk to somebody's
 * face — and stays low enough that the room continues behind them.
 */
export function focusPose(framing: FocusFraming): CameraPose {
  const distance = framing.distance ?? 2.6
  const heading = framing.heading
  return {
    position: {
      x: framing.position.x + Math.sin(heading) * -distance,
      y: EYE_HEIGHT + 0.18,
      z: framing.position.z + Math.cos(heading) * -distance,
    },
    target: { x: framing.position.x, y: EYE_HEIGHT * 0.86, z: framing.position.z },
  }
}

/**
 * Trailing a character who is moving.
 *
 * Higher and further back than focus, and behind rather than in front: the
 * point of following somebody is seeing where they are going.
 */
export function followPose(framing: FocusFraming): CameraPose {
  const distance = framing.distance ?? 4.4
  const heading = framing.heading
  return {
    position: {
      x: framing.position.x + Math.sin(heading) * distance,
      y: EYE_HEIGHT + 1.5,
      z: framing.position.z + Math.cos(heading) * distance,
    },
    target: { x: framing.position.x, y: EYE_HEIGHT * 0.8, z: framing.position.z },
  }
}

export interface CameraPoseInput {
  mode: WorldCameraMode
  overview: OverviewFraming
  subject?: FocusFraming
}

/**
 * The pose for a mode, falling back when there is nobody to look at.
 *
 * A camera pointed at a character who has left the world would sit staring at
 * empty floor; the whole company is the honest answer instead.
 */
export function poseFor(input: CameraPoseInput): CameraPose {
  if (input.mode === 'overview' || input.subject === undefined) return overviewPose(input.overview)
  return input.mode === 'follow' ? followPose(input.subject) : focusPose(input.subject)
}

/**
 * Moves a pose toward another, framerate-independently.
 *
 * `factor` is the fraction of the remaining distance closed per second, so the
 * camera settles at the same rate whether the tab is running at 30fps or 120.
 * A camera that snaps is the difference between a world and a slideshow.
 */
export function approachPose(current: CameraPose, target: CameraPose, factor: number, deltaMs: number): CameraPose {
  const step = 1 - Math.pow(1 - clamp(factor, 0, 0.999), Math.max(deltaMs, 0) / 1_000)
  return {
    position: approachPoint(current.position, target.position, step),
    target: approachPoint(current.target, target.target, step),
  }
}

/** Whether a pose is near enough to its target to stop animating. */
export function poseSettled(current: CameraPose, target: CameraPose, tolerance = 0.01): boolean {
  return distance(current.position, target.position) < tolerance
    && distance(current.target, target.target) < tolerance
}

function approachPoint(current: ScenePoint, target: ScenePoint, step: number): ScenePoint {
  return {
    x: current.x + (target.x - current.x) * step,
    y: current.y + (target.y - current.y) * step,
    z: current.z + (target.z - current.z) * step,
  }
}

function distance(left: ScenePoint, right: ScenePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

function horizontalFov(verticalFov: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(aspect, 0.0001))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
