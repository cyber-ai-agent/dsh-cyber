import { describe, expect, it } from 'vitest'

import {
  characterMotionProfile,
  sampleCharacterMotion,
} from '../src/character-animation-rig.js'

describe('character animation rig', () => {
  it('produces deterministic motion for the same activity and elapsed time', () => {
    const first = sampleCharacterMotion('walking', 315, { phaseOffset: 72 })
    const second = sampleCharacterMotion('walking', 315, { phaseOffset: 72 })

    expect(second).toEqual(first)
    expect(Math.abs(first.offsetY)).toBeGreaterThan(0)
  })

  it('keeps role bodies still when reduced motion is enabled', () => {
    expect(sampleCharacterMotion('celebrating', 240, { reducedMotion: true })).toEqual({
      offsetX: 0,
      offsetY: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      alpha: 1,
      phase: 0,
    })
  })

  it('uses visibly different motion profiles for conversation and navigation', () => {
    const talking = characterMotionProfile('talking')
    const walking = characterMotionProfile('walking')

    expect(walking.durationMs).not.toBe(talking.durationMs)
    expect(walking.rotation).toBeGreaterThan(talking.rotation)
    expect(walking.offsetY).toBeGreaterThan(talking.offsetY)
  })

  it('normalizes invalid elapsed values instead of leaking non-finite transforms', () => {
    const sample = sampleCharacterMotion('thinking', Number.POSITIVE_INFINITY)

    expect(Object.values(sample).every(Number.isFinite)).toBe(true)
  })
})
