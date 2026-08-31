import { describe, expect, it } from 'vitest'

import {
  capabilitiesFor,
  lodFor,
  lowerOf,
  stableLod,
  updateIntervalMs,
} from '../src/features/world/renderer/three/three-world-lod.js'

describe('lodFor', () => {
  it('runs a nearby character in full', () => {
    expect(lodFor({ distance: 3 })).toBe('full')
  })

  it('reduces a character too far away to read a face', () => {
    expect(lodFor({ distance: 14 })).toBe('reduced')
  })

  it('drops a distant character to a billboard', () => {
    expect(lodFor({ distance: 40 })).toBe('billboard')
  })

  it('never reduces the character the user is looking at', () => {
    expect(lodFor({ distance: 60, selected: true })).toBe('full')
  })

  it('never reduces a character who is talking', () => {
    // Lip sync on someone the user is listening to is the last thing to cut.
    expect(lodFor({ distance: 60, speaking: true })).toBe('full')
  })

  it('obeys a device ceiling even for the selected character', () => {
    // A machine that cannot afford a rigged avatar cannot afford one for the
    // selected character either; the ceiling is the whole point of a tier.
    expect(lodFor({ distance: 1, selected: true, ceiling: 'reduced' })).toBe('reduced')
    expect(lodFor({ distance: 1, speaking: true, ceiling: 'billboard' })).toBe('billboard')
  })

  it('does not raise a distant character to meet a generous ceiling', () => {
    expect(lodFor({ distance: 40, ceiling: 'full' })).toBe('billboard')
  })
})

describe('lowerOf', () => {
  it('takes the cheaper of two levels', () => {
    expect(lowerOf('full', 'reduced')).toBe('reduced')
    expect(lowerOf('billboard', 'full')).toBe('billboard')
    expect(lowerOf('reduced', 'reduced')).toBe('reduced')
  })
})

describe('capabilities', () => {
  it('keeps a face only where a face can be seen', () => {
    expect(capabilitiesFor('full').face).toBe(true)
    expect(capabilitiesFor('reduced').face).toBe(false)
    expect(capabilitiesFor('billboard').face).toBe(false)
  })

  it('stops paying for spring bones and shadows past full', () => {
    expect(capabilitiesFor('reduced').secondaryMotion).toBe(false)
    expect(capabilitiesFor('reduced').shadow).toBe(false)
    expect(capabilitiesFor('billboard').skinned).toBe(false)
  })
})

describe('update intervals', () => {
  it('lets a full actor update every frame and throttles the rest', () => {
    expect(updateIntervalMs('full')).toBe(0)
    expect(updateIntervalMs('reduced')).toBeGreaterThan(0)
    expect(updateIntervalMs('billboard')).toBeGreaterThan(updateIntervalMs('reduced'))
  })
})

describe('stableLod', () => {
  it('holds the current level inside the hysteresis margin', () => {
    // A character pacing across a threshold would otherwise rebuild its whole
    // representation every few frames.
    expect(stableLod('full', 'reduced', 9.6)).toBe('full')
    expect(stableLod('reduced', 'billboard', 22.6)).toBe('reduced')
  })

  it('gives way once the character is clearly past the boundary', () => {
    expect(stableLod('full', 'reduced', 12)).toBe('reduced')
    expect(stableLod('reduced', 'billboard', 30)).toBe('billboard')
  })

  it('is equally reluctant to upgrade', () => {
    expect(stableLod('billboard', 'reduced', 21)).toBe('billboard')
    expect(stableLod('reduced', 'full', 8.5)).toBe('reduced')
    expect(stableLod('reduced', 'full', 6)).toBe('full')
  })

  it('accepts any level for a character it has not seen before', () => {
    expect(stableLod(undefined, 'billboard', 9.2)).toBe('billboard')
  })
})
