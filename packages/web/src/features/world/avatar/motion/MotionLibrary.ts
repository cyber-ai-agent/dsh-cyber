import type { DigitalHumanGesture } from '../../digital-human-motion.js'

export interface MotionLibraryEntry {
  gesture: DigitalHumanGesture
  vrmaAssetUrl?: string
  transitionMs: number
}

/** URLs are intentionally data, not hard-coded inside the VRM renderer. */
export const DEFAULT_MOTION_LIBRARY: Record<DigitalHumanGesture, MotionLibraryEntry> = {
  breathe: { gesture: 'breathe', transitionMs: 320 },
  listen: { gesture: 'listen', transitionMs: 280 },
  explain: { gesture: 'explain', transitionMs: 250 },
  present: { gesture: 'present', transitionMs: 280 },
  hold: { gesture: 'hold', transitionMs: 220 },
  freeze: { gesture: 'freeze', transitionMs: 180 },
}
