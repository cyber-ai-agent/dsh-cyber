import type { DigitalHumanGesture } from '../../digital-human-motion.js'

export interface MotionLibraryEntry {
  gesture: DigitalHumanGesture
  vrmaAssetUrl?: string
  /** Named clip inside a multi-clip VRMA/glTF motion pack. */
  animationName?: MotionPackMotionName
  transitionMs: number
}

/**
 * Motions shipped by the repository's own starter pack.
 *
 * V2 is an authored Humanoid skeleton rather than a single rotating root. The
 * loader retargets its semantic bone tracks onto each VRM's normalized bones,
 * so the same tiny offline asset drives characters with different source rigs.
 */
export type MotionPackMotionName =
  | 'idle'
  | 'walk'
  | 'talk'
  | 'listen'
  | 'thinking'
  | 'typing'
  | 'present'
  | 'hold'
  | 'failed'

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
  /** The authored source format; third-party packs may still use real VRMA. */
  format: 'humanoid-gltf'
  assets: MotionPackAsset[]
}

const MOTION_ASSET_URL = '/assets/motions/dsh-basic.gltf'
const MOTION_NAMES: MotionPackMotionName[] = ['idle', 'walk', 'talk', 'listen', 'thinking', 'typing', 'present', 'hold', 'failed']

export const DSH_BASIC_MOTION_PACK: MotionPackManifest = {
  id: 'dsh-cyber-basic-motions',
  version: '2.0.0',
  license: 'MIT',
  source: 'DSH Cyber',
  format: 'humanoid-gltf',
  assets: MOTION_NAMES.map((name) => ({
    name,
    url: MOTION_ASSET_URL,
    license: 'MIT',
    source: 'DSH Cyber',
  })),
}

/** URLs and clip names are data, not hard-coded inside the VRM renderer. */
export const DEFAULT_MOTION_LIBRARY: Record<DigitalHumanGesture, MotionLibraryEntry> = {
  breathe: { gesture: 'breathe', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'idle', transitionMs: 320 },
  walk: { gesture: 'walk', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'walk', transitionMs: 180 },
  listen: { gesture: 'listen', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'listen', transitionMs: 260 },
  explain: { gesture: 'explain', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'talk', transitionMs: 220 },
  present: { gesture: 'present', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'present', transitionMs: 240 },
  hold: { gesture: 'hold', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'hold', transitionMs: 220 },
  freeze: { gesture: 'freeze', vrmaAssetUrl: MOTION_ASSET_URL, animationName: 'failed', transitionMs: 180 },
}
