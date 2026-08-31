import type { AnimationClip } from 'three'

import type { DigitalHumanGesture } from '../../digital-human-motion.js'
import { DEFAULT_MOTION_LIBRARY, type MotionLibraryEntry } from './MotionLibrary.js'

/**
 * Turns declared motion assets into clips the animation controller can play.
 *
 * `VrmAnimationController` has always been able to register clips and crossfade
 * between them, and `MotionLibrary` has always had a field for the asset URL.
 * Nothing connected the two, so the mixer ran with an empty action table and
 * every character's motion came from procedural bone manipulation — which is
 * why a walk looks like a bob rather than a walk.
 *
 * This is the missing connection. It is deliberately not a source of motion:
 * the repository ships no animation assets, and inventing keyframes here would
 * produce a worse walk than the procedural one while looking like real data. A
 * library with no URLs loads nothing and the character keeps its procedural
 * layer; the moment a theme or avatar pack declares assets, they play.
 */

export interface MotionClipSource {
  gesture: DigitalHumanGesture
  url: string
}

export interface LoadMotionClipsResult {
  clips: Array<{ gesture: DigitalHumanGesture; clip: AnimationClip }>
  /** Assets that were declared but could not be used, for a visible warning. */
  failures: Array<{ gesture: DigitalHumanGesture; url: string; reason: string }>
}

/** Every gesture in a library that actually points at an asset. */
export function declaredMotionSources(
  library: Record<DigitalHumanGesture, MotionLibraryEntry> = DEFAULT_MOTION_LIBRARY,
): MotionClipSource[] {
  return Object.values(library).flatMap((entry) =>
    entry.vrmaAssetUrl === undefined || entry.vrmaAssetUrl.trim() === ''
      ? []
      : [{ gesture: entry.gesture, url: entry.vrmaAssetUrl }])
}

/**
 * Loads the declared clips, retargeted onto this character.
 *
 * A VRM animation is authored against the VRM humanoid rather than one
 * model's skeleton, so the same asset drives every character. One asset
 * failing costs that gesture, not the character.
 */
export async function loadMotionClips(
  vrm: unknown,
  sources: readonly MotionClipSource[],
): Promise<LoadMotionClipsResult> {
  const result: LoadMotionClipsResult = { clips: [], failures: [] }
  if (sources.length === 0) return result

  const [loaderModule, animationModule] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('@pixiv/three-vrm-animation'),
  ])
  const loader = new loaderModule.GLTFLoader()
  loader.register((parser) => new animationModule.VRMAnimationLoaderPlugin(parser))

  for (const source of sources) {
    try {
      const gltf = await loader.loadAsync(source.url)
      const animations = (gltf.userData as { vrmAnimations?: unknown[] }).vrmAnimations ?? []
      const animation = animations[0]
      if (animation === undefined) {
        result.failures.push({ ...source, reason: '文件不包含 VRM 动画' })
        continue
      }
      const clip = animationModule.createVRMAnimationClip(
        animation as Parameters<typeof animationModule.createVRMAnimationClip>[0],
        vrm as Parameters<typeof animationModule.createVRMAnimationClip>[1],
      )
      result.clips.push({ gesture: source.gesture, clip })
    } catch (error) {
      result.failures.push({
        ...source,
        reason: error instanceof Error ? error.message : '动作资源加载失败',
      })
    }
  }
  return result
}
