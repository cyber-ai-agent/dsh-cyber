import type { AnimationClip, Object3D } from 'three'

import type { DigitalHumanGesture } from '../../digital-human-motion.js'
import { ResourceCache } from '../vrm/VrmResourceManager.js'
import { DEFAULT_MOTION_LIBRARY, type MotionLibraryEntry, type MotionPackMotionName } from './MotionLibrary.js'

/**
 * Turns declared motion assets into clips the animation controller can play.
 *
 * VRMA remains the strongest path: the official extension carries humanoid
 * semantics and `createVRMAnimationClip` retargets it. The bundled offline pack
 * is deliberately plain glTF so it stays tiny and self-authored; its node names
 * carry the same humanoid semantics and are retargeted onto the target VRM here.
 */

export interface MotionClipSource {
  gesture: DigitalHumanGesture
  url: string
  animationName?: MotionPackMotionName
}

export interface LoadMotionClipsResult {
  clips: Array<{ gesture: DigitalHumanGesture; clip: AnimationClip }>
  /** Assets that were declared but could not be used, for a visible warning. */
  failures: Array<{ gesture: DigitalHumanGesture; url: string; reason: string }>
  /** Releases this actor's share of the downloaded motion bytes. Idempotent. */
  release(): void
}

/** Shared across all actors and preview surfaces; parsed target clips stay per VRM. */
const motionBytes = new ResourceCache<ArrayBuffer>()

export function motionShareCount(url: string): number {
  return motionBytes.users(url)
}

/** Every gesture in a library that actually points at an asset. */
export function declaredMotionSources(
  library: Record<DigitalHumanGesture, MotionLibraryEntry> = DEFAULT_MOTION_LIBRARY,
): MotionClipSource[] {
  return Object.values(library).flatMap((entry) =>
    entry.vrmaAssetUrl === undefined || entry.vrmaAssetUrl.trim() === ''
      ? []
      : [{ gesture: entry.gesture, url: entry.vrmaAssetUrl, ...(entry.animationName === undefined ? {} : { animationName: entry.animationName }) }])
}

/**
 * Loads declared clips and retargets them onto this character.
 *
 * Download bytes are reference-counted by URL. Several employees entering a
 * room together therefore fetch a motion pack once while still receiving their
 * own target-specific AnimationClips and mixers.
 */
export async function loadMotionClips(
  vrm: unknown,
  sources: readonly MotionClipSource[],
): Promise<LoadMotionClipsResult> {
  const result: Omit<LoadMotionClipsResult, 'release'> = { clips: [], failures: [] }
  if (sources.length === 0) return { ...result, release: () => undefined }

  const [loaderModule, animationModule] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('@pixiv/three-vrm-animation'),
  ])
  const loader = new loaderModule.GLTFLoader()
  loader.register((parser) => new animationModule.VRMAnimationLoaderPlugin(parser))

  const leases = new Map<string, ReturnType<typeof motionBytes.acquireLease>>()
  const documents = new Map<string, Promise<Awaited<ReturnType<typeof loader.parseAsync>>>>()
  const documentFor = (url: string) => {
    let pending = documents.get(url)
    if (pending !== undefined) return pending
    const lease = motionBytes.acquireLease(url, async (signal) => {
      const response = await fetch(url, signal === undefined ? {} : { signal })
      if (!response.ok) throw new Error(`动作资源下载失败（${response.status}）`)
      return await response.arrayBuffer()
    }, () => undefined)
    leases.set(url, lease)
    pending = lease.promise.then((bytes) => loader.parseAsync(bytes.slice(0), baseUrlOf(url)))
    documents.set(url, pending)
    return pending
  }

  for (const source of sources) {
    try {
      const gltf = await documentFor(source.url)
      const animations = (gltf.userData as { vrmAnimations?: unknown[] }).vrmAnimations ?? []
      const animation = source.animationName === undefined
        ? animations[0]
        : animations.find((item) => typeof item === 'object' && item !== null && (item as { name?: unknown }).name === source.animationName)
          ?? animations[0]
      const clip = animation !== undefined
        ? animationModule.createVRMAnimationClip(
          animation as Parameters<typeof animationModule.createVRMAnimationClip>[0],
          vrm as Parameters<typeof animationModule.createVRMAnimationClip>[1],
        )
        : selectSelfAuthoredClip(gltf.animations, source.animationName, vrm)
      if (clip === undefined || clip.tracks.length === 0) {
        result.failures.push({ ...source, reason: '文件不包含可重定向的 Humanoid 动画' })
        continue
      }
      result.clips.push({ gesture: source.gesture, clip })
    } catch (error) {
      result.failures.push({
        ...source,
        reason: error instanceof Error ? error.message : '动作资源加载失败',
      })
    }
  }

  let released = false
  return {
    ...result,
    release: () => {
      if (released) return
      released = true
      for (const lease of leases.values()) lease.release()
    },
  }
}

/**
 * Retargets the repository's self-authored glTF skeleton onto a VRM humanoid.
 *
 * Source nodes are named `dsh-bone-<VRM bone name>`. AnimationMixer can bind to
 * an Object3D UUID, so rewriting to the normalized target bone's UUID avoids
 * depending on whatever names a creator happened to use in their VRM file.
 */
function selectSelfAuthoredClip(
  animations: readonly AnimationClip[],
  name: MotionPackMotionName | undefined,
  vrm: unknown,
): AnimationClip | undefined {
  const source = name === undefined ? animations[0] : animations.find((clip) => clip.name === name) ?? animations[0]
  if (source === undefined) return undefined
  const clip = source.clone()
  const humanoid = (vrm as { humanoid?: { getNormalizedBoneNode(name: string): Object3D | null } } | undefined)?.humanoid
  const tracks = clip.tracks.flatMap((track) => {
    const semantic = /^dsh-bone-([^.]+)\.(quaternion|position|scale)$/u.exec(track.name)
    if (semantic !== null) {
      const target = humanoid?.getNormalizedBoneNode(semantic[1]!)
      if (target === null || target === undefined) return []
      const cloned = track.clone()
      cloned.name = `${target.uuid}.${semantic[2]}`
      return [cloned]
    }
    // Compatibility for the original v1 starter pack. New packs should never
    // animate the actor root as their only motion, but old installed packs do
    // not need to break when this runtime is upgraded.
    if (/^dsh-motion-root\./u.test(track.name)) {
      const cloned = track.clone()
      cloned.name = track.name.replace(/^dsh-motion-root/u, '')
      return [cloned]
    }
    return []
  })
  clip.tracks = tracks
  return clip
}

function baseUrlOf(assetUrl: string): string {
  if (assetUrl.startsWith('data:') || assetUrl.startsWith('blob:')) return ''
  const index = assetUrl.lastIndexOf('/')
  return index < 0 ? '' : assetUrl.slice(0, index + 1)
}
