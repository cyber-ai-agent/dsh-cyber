import { describe, expect, it } from 'vitest'

import {
  BARGE_IN_HYSTERESIS,
  MAX_BARGE_IN_RMS,
  MIN_BARGE_IN_RMS,
  calculateBargeInThreshold,
  isBargeInFrame,
  pcmRms,
  updateEchoBaseline,
} from '../src/features/voice/barge-in-threshold.js'

function frame(value: number, length = 128): ArrayBuffer {
  const samples = new Int16Array(length)
  samples.fill(Math.round(value * 32_768))
  return samples.buffer
}

describe('barge-in threshold', () => {
  it('lets the recogniser handle frames when nothing is playing', () => {
    expect(isBargeInFrame(frame(0), undefined)).toBe(true)
    expect(isBargeInFrame(frame(0.01), 0)).toBe(true)
  })

  it('rejects quiet speaker echo but accepts a clear interruption', () => {
    const quiet = calculateBargeInThreshold(0.1, 0.03)
    expect(isBargeInFrame(frame(quiet * 0.8), 0.1, 0.03, quiet)).toBe(false)
    expect(isBargeInFrame(frame(quiet + BARGE_IN_HYSTERESIS + 0.02), 0.1, 0.03, quiet)).toBe(true)
  })

  it('keeps the gate reachable with loud playback', () => {
    const threshold = calculateBargeInThreshold(1, 0.4)
    expect(threshold).toBe(MAX_BARGE_IN_RMS)
    expect(threshold).toBeLessThanOrEqual(1)
    expect(isBargeInFrame(frame(0.99), 1, 0.4, threshold)).toBe(true)
  })

  it('uses bounded echo baseline and threshold hysteresis', () => {
    expect(updateEchoBaseline(0, 0.2, undefined)).toBe(0)
    expect(updateEchoBaseline(0.2, 2, 0.2)).toBeCloseTo(0.2, 6)
    const threshold = calculateBargeInThreshold(0.2, 0.1)
    expect(threshold).toBeGreaterThanOrEqual(MIN_BARGE_IN_RMS)
    expect(threshold).toBeLessThanOrEqual(MAX_BARGE_IN_RMS)
    expect(calculateBargeInThreshold(0.2, 0.101, threshold)).toBe(threshold)
  })

  it('calculates normalized PCM RMS without throwing on odd byte lengths', () => {
    expect(pcmRms(frame(0.25))).toBeCloseTo(0.25, 3)
    expect(pcmRms(new Uint8Array([0]).buffer)).toBe(0)
  })
})
