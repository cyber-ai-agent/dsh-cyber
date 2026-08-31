import type { WorldFacing, WorldPoint, WorldRuntimeSnapshot } from '@dsh-cyber/contracts'

/**
 * Where every character actually is on screen, independent of who is drawing.
 *
 * The server is not the authority for a walking character. `projectWorldRuntime`
 * emits an `entity.route` cue with the whole path and leaves `entity.position`
 * at the origin until a later event settles the character at its target, so a
 * snapshot taken mid-walk reports the place the character left, not the place
 * it is. The renderer has always owned the interpolation.
 *
 * That was survivable while one renderer existed for the lifetime of the view.
 * It stops being survivable the moment 2D and 3D are two renderers of one
 * world: tearing one down and building the other would read the stale snapshot
 * position and teleport everybody back to where their current walk started.
 *
 * So the walk lives here instead — plain arithmetic over world points, owned
 * above the renderers and outliving both of them.
 */

/** Scene pixels per second. Matches the speed the 2D world has always walked at. */
export const WORLD_WALK_SPEED = 230

/** A walk short enough to look like a step still takes this long. */
const MIN_SEGMENT_MS = 90

export interface WorldLocomotionState {
  position: WorldPoint
  facing: WorldFacing
  walking: boolean
}

interface LiveRoute {
  points: WorldPoint[]
  segment: number
  elapsed: number
  segmentDuration: number
}

interface LiveEntity {
  position: WorldPoint
  facing: WorldFacing
  route: LiveRoute | undefined
}

export class WorldLocomotion {
  readonly #entities = new Map<string, LiveEntity>()

  /**
   * Adopts server positions, without disturbing anybody mid-walk.
   *
   * A snapshot that arrives while a character is walking still carries the
   * pre-walk origin, so applying it would jerk the character backwards on
   * every streamed token.
   */
  syncSnapshot(snapshot: WorldRuntimeSnapshot): void {
    const present = new Set<string>()
    for (const entity of snapshot.entities) {
      present.add(entity.id)
      const live = this.#entities.get(entity.id)
      if (live === undefined) {
        this.#entities.set(entity.id, { position: { ...entity.position }, facing: entity.facing, route: undefined })
        continue
      }
      if (live.route !== undefined) continue
      live.position = { ...entity.position }
      live.facing = entity.facing
    }
    for (const id of [...this.#entities.keys()]) {
      if (!present.has(id)) this.#entities.delete(id)
    }
  }

  /**
   * Starts a walk from where the character actually is.
   *
   * The route's first point is the position the server thought the character
   * had when it planned the path. Replacing it with the live position is what
   * keeps a character that is already moving from snapping to the start of its
   * new path.
   */
  beginRoute(entityId: string, points: readonly WorldPoint[]): void {
    if (points.length < 2) return
    const live = this.#entities.get(entityId) ?? { position: { ...points[0]! }, facing: 'south' as WorldFacing, route: undefined }
    const route = [{ ...live.position }, ...points.slice(1).map((point) => ({ ...point }))]
    live.route = { points: route, segment: 0, elapsed: 0, segmentDuration: segmentDuration(route[0]!, route[1]!) }
    live.facing = facingBetween(route[0]!, route[1]!)
    this.#entities.set(entityId, live)
  }

  /** Advances every live walk. Pure arithmetic; draws nothing. */
  advance(deltaMs: number): void {
    if (deltaMs <= 0) return
    for (const live of this.#entities.values()) {
      let remaining = deltaMs
      while (live.route !== undefined && remaining > 0) {
        const route = live.route
        const from = route.points[route.segment]
        const to = route.points[route.segment + 1]
        if (from === undefined || to === undefined) {
          live.route = undefined
          break
        }
        const step = Math.min(remaining, route.segmentDuration - route.elapsed)
        route.elapsed += step
        remaining -= step
        const progress = clamp(route.elapsed / route.segmentDuration, 0, 1)
        live.position = { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress) }
        live.facing = facingBetween(from, to)
        if (progress < 1) break
        route.segment += 1
        route.elapsed = 0
        const next = route.points[route.segment + 1]
        if (next === undefined) {
          live.position = { ...to }
          live.route = undefined
          break
        }
        route.segmentDuration = segmentDuration(to, next)
      }
    }
  }

  stateOf(entityId: string): WorldLocomotionState | undefined {
    const live = this.#entities.get(entityId)
    if (live === undefined) return undefined
    return { position: { ...live.position }, facing: live.facing, walking: live.route !== undefined }
  }

  /** The position a renderer should draw, falling back to the snapshot's. */
  positionOf(entityId: string, fallback: WorldPoint): WorldPoint {
    return this.#entities.get(entityId)?.position ?? fallback
  }

  isWalking(entityId: string): boolean {
    return this.#entities.get(entityId)?.route !== undefined
  }

  /** Everyone currently mid-walk, for a renderer taking over a live world. */
  walkingEntityIds(): string[] {
    return [...this.#entities.entries()].filter(([, live]) => live.route !== undefined).map(([id]) => id)
  }

  forget(entityId?: string): void {
    if (entityId === undefined) this.#entities.clear()
    else this.#entities.delete(entityId)
  }
}

/**
 * Renderer-independent world clock.
 *
 * A renderer can be destroyed while a lazy replacement loads. Keeping the
 * timestamp and advancing the shared locomotion store here means elapsed wall
 * time still belongs to the world during that gap, with exactly one owner for
 * each interval.
 */
export class WorldLocomotionClock {
  readonly #locomotion: WorldLocomotion
  #lastAt: number | undefined

  constructor(locomotion: WorldLocomotion) {
    this.#locomotion = locomotion
  }

  tick(timestamp: number): void {
    if (this.#lastAt === undefined) {
      this.#lastAt = timestamp
      return
    }
    const delta = Math.max(0, timestamp - this.#lastAt)
    this.#lastAt = timestamp
    this.#locomotion.advance(delta)
  }

  reset(timestamp?: number): void {
    this.#lastAt = timestamp
  }
}

export function segmentDuration(from: WorldPoint, to: WorldPoint): number {
  return Math.max(MIN_SEGMENT_MS, Math.hypot(to.x - from.x, to.y - from.y) / WORLD_WALK_SPEED * 1_000)
}

export function facingBetween(from: WorldPoint, to: WorldPoint): WorldFacing {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return Math.abs(dx) > Math.abs(dy) ? (dx >= 0 ? 'east' : 'west') : (dy >= 0 ? 'south' : 'north')
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
