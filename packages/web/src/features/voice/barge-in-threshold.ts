/**
 * Pure signal policy for deciding whether a microphone frame is a real
 * interruption rather than the character coming back through the speakers.
 *
 * Mic and speaker analyser values are both normalized RMS values, but their
 * hardware paths are not calibrated to one another. Keep the policy adaptive,
 * bounded and hysteretic so a loud speaker can never make the gate impossible.
 */

export const MIN_BARGE_IN_RMS = 0.06
export const MAX_BARGE_IN_RMS = 0.78
export const BARGE_IN_MULTIPLIER = 1.25
export const BARGE_IN_MARGIN = 0.02
export const BARGE_IN_HYSTERESIS = 0.015
export const ECHO_BASELINE_FLOOR = 0.018

export function calculateBargeInThreshold(
  playbackAmplitude: number | undefined,
  echoBaseline = 0,
  previousThreshold?: number,
): number {
  const playback = finiteUnit(playbackAmplitude)
  const baseline = finiteUnit(echoBaseline)
  const candidate = clamp(
    Math.max(ECHO_BASELINE_FLOOR, baseline) + playback * BARGE_IN_MULTIPLIER + BARGE_IN_MARGIN,
    MIN_BARGE_IN_RMS,
    MAX_BARGE_IN_RMS,
  )
  if (previousThreshold === undefined || !Number.isFinite(previousThreshold)) return candidate
  const previous = clamp(previousThreshold, MIN_BARGE_IN_RMS, MAX_BARGE_IN_RMS)
  if (Math.abs(candidate - previous) <= BARGE_IN_HYSTERESIS) return previous
  return candidate
}

/** Update the estimated speaker echo floor from frames that look like echo. */
export function updateEchoBaseline(previous: number, frameRms: number, playbackAmplitude: number | undefined): number {
  const playback = finiteUnit(playbackAmplitude)
  const frame = finiteUnit(frameRms)
  if (playback <= 0.01) return clamp(previous, 0, 1)
  // A frame near the playback level is useful baseline evidence; a frame much
  // louder than it is probably the user's interruption and must not raise the
  // next threshold.
  if (frame > playback * 1.5 + BARGE_IN_MARGIN) return clamp(previous, 0, 1)
  return clamp((clamp(previous, 0, 1) * 0.9) + (frame * 0.1), 0, 1)
}

export function pcmRms(frame: ArrayBuffer): number {
  const length = frame.byteLength - (frame.byteLength % 2)
  if (length === 0) return 0
  const samples = new Int16Array(frame, 0, length / 2)
  let energy = 0
  for (const sample of samples) {
    const normalized = sample / 32_768
    energy += normalized * normalized
  }
  return Math.sqrt(energy / samples.length)
}

/** Return true when this frame crosses the bounded interruption gate. */
export function isBargeInFrame(frame: ArrayBuffer, playbackAmplitude: number | undefined, echoBaseline = 0, previousThreshold?: number): boolean {
  if (playbackAmplitude === undefined || playbackAmplitude <= 0.01) return true
  const rms = pcmRms(frame)
  const threshold = calculateBargeInThreshold(playbackAmplitude, echoBaseline, previousThreshold)
  return rms >= threshold + BARGE_IN_HYSTERESIS
}

function finiteUnit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : clamp(value, 0, 1)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
