import type { AnimationClip } from 'three'

import type { DigitalHumanGesture } from '../../digital-human-motion.js'

/**
 * High-confidence semantic mappings for animations already embedded in a VRM.
 *
 * The official CC0 Base contains many game-oriented clips too. We intentionally
 * do not map a kneeling repair, weapon pose or dance to office work merely
 * because it moves more. A wrong authored motion is more distracting than the
 * existing procedural fallback, so only names whose meaning matches the world
 * gesture are eligible here.
 */
export const EMBEDDED_GESTURE_CLIP_CANDIDATES: Readonly<Record<DigitalHumanGesture, readonly string[]>> = {
  breathe: ['Idle_Loop'],
  walk: ['Walk_Loop', 'Walk_Formal_Loop'],
  listen: ['Idle_Loop'],
  explain: ['Idle_Talking_Loop'],
  present: ['Interact'],
  hold: ['Idle_Loop'],
  // Failure is primarily communicated by expression/state. Keeping a real
  // neutral idle here avoids snapping into T-pose or a game-like death clip.
  freeze: ['Idle_Loop'],
}

export interface EmbeddedMotionClip {
  gesture: DigitalHumanGesture
  clip: AnimationClip
}

/** Selects at most one embedded authored clip for every world gesture. */
export function selectEmbeddedMotionClips(animations: readonly AnimationClip[]): EmbeddedMotionClip[] {
  const byName = new Map<string, AnimationClip>()
  for (const clip of animations) {
    const name = clip.name.trim()
    if (name !== '' && !byName.has(name)) byName.set(name, clip)
  }

  const selected: EmbeddedMotionClip[] = []
  for (const [gesture, candidates] of Object.entries(EMBEDDED_GESTURE_CLIP_CANDIDATES) as Array<[
    DigitalHumanGesture,
    readonly string[],
  ]>) {
    const clip = candidates.map((name) => byName.get(name)).find((item): item is AnimationClip => item !== undefined)
    if (clip !== undefined) selected.push({ gesture, clip })
  }
  return selected
}
