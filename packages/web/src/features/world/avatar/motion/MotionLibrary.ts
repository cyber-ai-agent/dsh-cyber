import type { DigitalHumanGesture } from '../../digital-human-motion.js'

export interface MotionLibraryEntry {
  gesture: DigitalHumanGesture
  vrmaAssetUrl?: string
  /** Named clip inside a multi-clip VRMA/glTF motion pack. */
  animationName?: MotionPackMotionName
  transitionMs: number
}

/**
 * Motions shipped by the repository's own starter pack. The pack intentionally
 * uses a tiny self-authored glTF so every default clip has a redistributable
 * license and remains runnable in offline/local-first installs.
 */
export type MotionPackMotionName = 'idle' | 'walk' | 'talk' | 'listen' | 'thinking' | 'typing'

export interface MotionPackAsset {
  name: MotionPackMotionName
  url: string
  license: 'MIT'
  source: 'DSH Cyber'
}

export interface MotionPackManifest {
  id: string
  version: string
  license: 'MIT'
  source: 'DSH Cyber'
  assets: MotionPackAsset[]
}

export const DSH_BASIC_MOTION_PACK: MotionPackManifest = {
  id: 'dsh-cyber-basic-motions',
  version: '1.0.0',
  license: 'MIT',
  source: 'DSH Cyber',
  assets: (['idle', 'walk', 'talk', 'listen', 'thinking', 'typing'] as MotionPackMotionName[]).map((name) => ({
    name,
    url: '/assets/motions/dsh-basic.gltf',
    license: 'MIT',
    source: 'DSH Cyber',
  })),
}

/** URLs are intentionally data, not hard-coded inside the VRM renderer. */
export const DEFAULT_MOTION_LIBRARY: Record<DigitalHumanGesture, MotionLibraryEntry> = {
  breathe: { gesture: 'breathe', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[0]!.url, animationName: 'idle', transitionMs: 320 },
  walk: { gesture: 'walk', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[1]!.url, animationName: 'walk', transitionMs: 220 },
  listen: { gesture: 'listen', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[3]!.url, animationName: 'listen', transitionMs: 280 },
  explain: { gesture: 'explain', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[2]!.url, animationName: 'talk', transitionMs: 250 },
  present: { gesture: 'present', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[2]!.url, animationName: 'talk', transitionMs: 280 },
  hold: { gesture: 'hold', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[5]!.url, animationName: 'typing', transitionMs: 220 },
  freeze: { gesture: 'freeze', vrmaAssetUrl: DSH_BASIC_MOTION_PACK.assets[4]!.url, animationName: 'thinking', transitionMs: 180 },
}
