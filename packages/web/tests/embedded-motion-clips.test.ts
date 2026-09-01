import { AnimationClip } from 'three'
import { describe, expect, it } from 'vitest'

import {
  EMBEDDED_GESTURE_CLIP_CANDIDATES,
  selectEmbeddedMotionClips,
} from '../src/features/world/avatar/motion/embedded-motion-clips.js'

describe('embedded VRM motion selection', () => {
  it('maps only semantically trustworthy office gestures from the official clip set', () => {
    const animations = [
      'Idle_Loop',
      'Walk_Loop',
      'Idle_Talking_Loop',
      'Interact',
      'Fixing_Kneeling',
      'Dance_Loop',
      'Pistol_Shoot',
      'Death01',
    ].map((name) => new AnimationClip(name, 1, []))

    const selected = selectEmbeddedMotionClips(animations)
    expect(Object.fromEntries(selected.map(({ gesture, clip }) => [gesture, clip.name]))).toEqual({
      breathe: 'Idle_Loop',
      walk: 'Walk_Loop',
      listen: 'Idle_Loop',
      explain: 'Idle_Talking_Loop',
      present: 'Interact',
      hold: 'Idle_Loop',
      freeze: 'Idle_Loop',
    })
    expect(selected.some(({ clip }) => /Fixing|Dance|Pistol|Death/u.test(clip.name))).toBe(false)
  })

  it('uses the formal walk only as an honest fallback when the normal walk is absent', () => {
    const selected = selectEmbeddedMotionClips([
      new AnimationClip('Idle_Loop', 1, []),
      new AnimationClip('Walk_Formal_Loop', 1, []),
    ])
    expect(selected.find(({ gesture }) => gesture === 'walk')?.clip.name).toBe('Walk_Formal_Loop')
  })

  it('keeps the candidate table complete for every runtime gesture', () => {
    expect(Object.keys(EMBEDDED_GESTURE_CLIP_CANDIDATES).sort()).toEqual([
      'breathe',
      'explain',
      'freeze',
      'hold',
      'listen',
      'present',
      'walk',
    ])
  })
})
