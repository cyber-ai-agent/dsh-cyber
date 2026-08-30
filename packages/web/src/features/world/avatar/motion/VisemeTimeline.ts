export type VrmViseme = 'aa' | 'ih' | 'ou' | 'ee' | 'oh' | 'neutral'

export interface VisemeFrame {
  time: number
  viseme: VrmViseme
  weight: number
}

export interface VisemeTimeline {
  frames: VisemeFrame[]
  duration: number
}

/** Provider-neutral fallback until a TTS adapter supplies timed visemes. */
export function sampleSpeechActivity(time: number, speaking: boolean, pcmAmplitude?: number): number {
  if (!speaking) return 0
  if (pcmAmplitude !== undefined) return Math.max(0, Math.min(1, pcmAmplitude * 3.6))
  return 0.12 + Math.abs(Math.sin(time / 92) * 0.72)
}
