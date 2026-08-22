import type { WorldActivityKind } from '@dsh-cyber/contracts'

export type CharacterAnimationRigKind =
  | 'spritesheet'
  | 'layered-spritesheet'
  | 'procedural'

export interface CharacterMotionSample {
  offsetX: number
  offsetY: number
  rotation: number
  scaleX: number
  scaleY: number
  alpha: number
  phase: number
}

export interface CharacterMotionProfile {
  durationMs: number
  offsetX: number
  offsetY: number
  rotation: number
  scaleX: number
  scaleY: number
  alphaPulse: number
}

export interface SampleCharacterMotionOptions {
  reducedMotion?: boolean
  phaseOffset?: number
}

const NEUTRAL_SAMPLE: CharacterMotionSample = {
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  alpha: 1,
  phase: 0,
}

const MOTION_PROFILES: Record<WorldActivityKind, CharacterMotionProfile> = {
  idle: {
    durationMs: 2_400,
    offsetX: 0,
    offsetY: 1.4,
    rotation: 0.005,
    scaleX: 0.006,
    scaleY: 0.012,
    alphaPulse: 0,
  },
  walking: {
    durationMs: 420,
    offsetX: 1.8,
    offsetY: 3.2,
    rotation: 0.045,
    scaleX: 0.025,
    scaleY: 0.035,
    alphaPulse: 0,
  },
  thinking: {
    durationMs: 1_500,
    offsetX: 0.8,
    offsetY: 1.6,
    rotation: 0.025,
    scaleX: 0.008,
    scaleY: 0.014,
    alphaPulse: 0.025,
  },
  working: {
    durationMs: 720,
    offsetX: 1.2,
    offsetY: 1.8,
    rotation: 0.018,
    scaleX: 0.012,
    scaleY: 0.018,
    alphaPulse: 0,
  },
  talking: {
    durationMs: 360,
    offsetX: 0.6,
    offsetY: 2.1,
    rotation: 0.012,
    scaleX: 0.018,
    scaleY: 0.035,
    alphaPulse: 0.018,
  },
  meeting: {
    durationMs: 1_100,
    offsetX: 0.5,
    offsetY: 1.2,
    rotation: 0.01,
    scaleX: 0.008,
    scaleY: 0.012,
    alphaPulse: 0,
  },
  blocked: {
    durationMs: 900,
    offsetX: 1.5,
    offsetY: 0.8,
    rotation: 0.035,
    scaleX: 0.01,
    scaleY: 0.01,
    alphaPulse: 0.08,
  },
  celebrating: {
    durationMs: 520,
    offsetX: 1.4,
    offsetY: 5.5,
    rotation: 0.05,
    scaleX: 0.035,
    scaleY: 0.05,
    alphaPulse: 0.025,
  },
}

export function characterMotionProfile(activity: WorldActivityKind): CharacterMotionProfile {
  return { ...MOTION_PROFILES[activity] }
}

export function sampleCharacterMotion(
  activity: WorldActivityKind,
  elapsedMs: number,
  options: SampleCharacterMotionOptions = {},
): CharacterMotionSample {
  if (options.reducedMotion === true) return { ...NEUTRAL_SAMPLE }

  const profile = MOTION_PROFILES[activity]
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const phaseOffset = Number.isFinite(options.phaseOffset) ? options.phaseOffset ?? 0 : 0
  const phase = ((safeElapsed + phaseOffset) % profile.durationMs) / profile.durationMs
  const wave = Math.sin(phase * Math.PI * 2)
  const stride = Math.sin(phase * Math.PI * 4)
  const lift = activity === 'walking' || activity === 'celebrating'
    ? Math.abs(stride)
    : (wave + 1) / 2

  return {
    offsetX: round(profile.offsetX * stride),
    offsetY: round(-profile.offsetY * lift),
    rotation: round(profile.rotation * wave),
    scaleX: round(1 + profile.scaleX * stride),
    scaleY: round(1 + profile.scaleY * lift),
    alpha: round(clamp(1 - profile.alphaPulse * ((wave + 1) / 2), 0.72, 1)),
    phase: round(phase),
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
