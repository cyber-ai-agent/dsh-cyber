import { describe, expect, it } from 'vitest'

import {
  DEFAULT_VOICE_SPEED,
  MAX_VOICE_SPEED,
  MIN_VOICE_SPEED,
  normalizeVoiceSpeed,
} from '../src/features/voice/employee-voice-profile.js'

describe('voice speed', () => {
  it('reaches a speed worth having', () => {
    // The ceiling was 1.3x, barely above conversational, which is why playback
    // read as slow: a user moving through a long answer had nowhere to go.
    expect(MAX_VOICE_SPEED).toBeGreaterThanOrEqual(1.8)
    expect(normalizeVoiceSpeed(1.8)).toBeCloseTo(1.8, 6)
    expect(normalizeVoiceSpeed(2)).toBeCloseTo(2, 6)
  })

  it('still refuses a speed nobody could follow', () => {
    expect(normalizeVoiceSpeed(6)).toBe(MAX_VOICE_SPEED)
    expect(normalizeVoiceSpeed(0.1)).toBe(MIN_VOICE_SPEED)
  })

  it('keeps a slow speed available for listening carefully', () => {
    expect(MIN_VOICE_SPEED).toBeLessThanOrEqual(0.8)
    expect(normalizeVoiceSpeed(0.75)).toBeCloseTo(0.75, 6)
  })

  it('falls back rather than failing on nonsense', () => {
    expect(normalizeVoiceSpeed(undefined)).toBe(DEFAULT_VOICE_SPEED)
    expect(normalizeVoiceSpeed(Number.NaN)).toBe(DEFAULT_VOICE_SPEED)
  })

  it('rounds to the step the slider offers', () => {
    expect(normalizeVoiceSpeed(1.234)).toBeCloseTo(1.25, 6)
  })
})
