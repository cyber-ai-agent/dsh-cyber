/**
 * How much of a character to actually run.
 *
 * A world with fifty characters cannot afford fifty rigged avatars with spring
 * bones, blinking and lip sync. It does not need them either: past a few metres
 * nobody can see an eyelid. The level decides both what an actor is made of and
 * how often it is allowed to think.
 *
 * Distances are in scene metres, so they mean the same thing in every world.
 */

export type AvatarLod = 'full' | 'reduced' | 'billboard'

export interface LodInput {
  /** Metres from the camera. */
  distance: number
  /** The character the user is looking at is never reduced. */
  selected?: boolean
  /** A character being talked to keeps its face, wherever it stands. */
  speaking?: boolean
  /** Ceiling imposed by the device, from the rendering quality tier. */
  ceiling?: AvatarLod
}

const REDUCED_BEYOND = 9
const BILLBOARD_BEYOND = 22

const RANK: Record<AvatarLod, number> = { billboard: 0, reduced: 1, full: 2 }

export function lodFor(input: LodInput): AvatarLod {
  const natural = input.selected === true || input.speaking === true
    ? 'full'
    : input.distance <= REDUCED_BEYOND
      ? 'full'
      : input.distance <= BILLBOARD_BEYOND ? 'reduced' : 'billboard'
  return lowerOf(natural, input.ceiling ?? 'full')
}

export function lowerOf(left: AvatarLod, right: AvatarLod): AvatarLod {
  return RANK[left] <= RANK[right] ? left : right
}

/**
 * How often an actor at this level may update, in milliseconds.
 *
 * Not a frame budget for the renderer — the scene still draws every frame —
 * but a cap on how often an actor recomputes anything of its own.
 */
export function updateIntervalMs(lod: AvatarLod): number {
  switch (lod) {
    case 'full': return 0
    case 'reduced': return 1_000 / 24
    case 'billboard': return 1_000 / 12
  }
}

export interface LodCapabilities {
  /** Eye movement, expressions and lip sync. */
  face: boolean
  /** Procedural micro-motion and spring bones. */
  secondaryMotion: boolean
  /** A full skinned mesh rather than a stand-in. */
  skinned: boolean
  /** Casts a shadow. */
  shadow: boolean
}

export function capabilitiesFor(lod: AvatarLod): LodCapabilities {
  switch (lod) {
    case 'full': return { face: true, secondaryMotion: true, skinned: true, shadow: true }
    case 'reduced': return { face: false, secondaryMotion: false, skinned: true, shadow: false }
    case 'billboard': return { face: false, secondaryMotion: false, skinned: false, shadow: false }
  }
}

/**
 * Hysteresis, so a character standing on a boundary does not flicker.
 *
 * Changing level costs a rebuild; a character pacing across the reduced
 * threshold would rebuild every few frames without this.
 */
export function stableLod(previous: AvatarLod | undefined, next: AvatarLod, distance: number): AvatarLod {
  if (previous === undefined || previous === next) return next
  const margin = 1.5
  if (previous === 'full' && next === 'reduced' && distance < REDUCED_BEYOND + margin) return 'full'
  if (previous === 'reduced' && next === 'billboard' && distance < BILLBOARD_BEYOND + margin) return 'reduced'
  if (previous === 'billboard' && next === 'reduced' && distance > BILLBOARD_BEYOND - margin) return 'billboard'
  if (previous === 'reduced' && next === 'full' && distance > REDUCED_BEYOND - margin) return 'reduced'
  return next
}
