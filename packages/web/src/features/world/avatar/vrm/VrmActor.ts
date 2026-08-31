import type { VRM } from '@pixiv/three-vrm'
import type { Object3D } from 'three'

import type { DigitalHumanMotionCue, DigitalHumanVisualState } from '../../digital-human-motion.js'
import type { AvatarAssemblyPlan, AvatarBasePackManifest } from '../avatar-base-pack.js'
import { declaredMotionSources, loadMotionClips } from '../motion/load-motion-clips.js'
import { applyAvatarAssembly } from './apply-avatar-assembly.js'
import { VrmAnimationController } from './VrmAnimationController.js'
import { VrmBlinkController } from './VrmBlinkController.js'
import { VrmExpressionController } from './VrmExpressionController.js'
import { VrmLookAtController } from './VrmLookAtController.js'
import { VrmMotionController } from './VrmMotionController.js'
import { ResourceCache, disposeVrmScene } from './VrmResourceManager.js'
import { VrmSpeechController } from './VrmSpeechController.js'

/**
 * One VRM character, with no opinion about whose scene it is in.
 *
 * It owns an Object3D and character behaviour, never a renderer/camera/context.
 * That is what allows many employees to inhabit the one Three world.
 */

export interface VrmActorLoadOptions {
  assetUrl: string
  /**
   * What to share this download under. Defaults to the URL.
   *
   * The bytes are shared, not the humanoid instance: expressions and bones are
   * stateful, so each employee parses its own VRM while avoiding duplicate
   * network downloads for a shared Base Pack.
   */
  cacheKey?: string
  /** Optional cheap identity layer applied after a shared Base VRM is parsed. */
  assembly?: { pack: AvatarBasePackManifest; plan: AvatarAssemblyPlan }
  signal?: AbortSignal
}

/** Downloaded avatar files, shared across world and preview surfaces. */
const avatarBytes = new ResourceCache<ArrayBuffer>()

/** For tests and diagnostics: how many characters share a downloaded file. */
export function avatarShareCount(cacheKey: string): number {
  return avatarBytes.users(cacheKey)
}

export interface VrmActorUpdateInput {
  state: DigitalHumanVisualState
  motionCue: DigitalHumanMotionCue
  speaking: boolean
  /** False freezes secondary motion without tearing the character down. */
  animated: boolean
  /** How much of the character to run at this LOD. */
  detail?: { face: boolean; secondaryMotion: boolean }
  /** Per-character speech loudness, 0..1. */
  amplitude?: number
  /** Something in the world worth looking at — a speaker or the viewer. */
  lookAt?: { x: number; y: number; z: number }
}

export class VrmActor {
  readonly root: Object3D
  readonly vrm: VRM

  readonly #motion: VrmMotionController
  readonly #expression: VrmExpressionController
  readonly #lookAt: VrmLookAtController
  readonly #blink: VrmBlinkController
  readonly #speech: VrmSpeechController
  readonly #animation: VrmAnimationController
  readonly #onDispose: (() => void) | undefined

  #motionRelease: (() => void) | undefined
  #elapsed = 0
  #springFrame = 0
  #disposed = false

  private constructor(vrm: VRM, onDispose?: () => void) {
    this.vrm = vrm
    this.root = vrm.scene
    this.#motion = new VrmMotionController(vrm)
    this.#expression = new VrmExpressionController(vrm)
    this.#lookAt = new VrmLookAtController(vrm)
    this.#blink = new VrmBlinkController(vrm)
    this.#speech = new VrmSpeechController(vrm)
    this.#animation = new VrmAnimationController(vrm.scene)
    this.#onDispose = onDispose
  }

  /**
   * Loads a character. Three, GLTFLoader, Meshopt and three-vrm remain behind
   * this async boundary so a 2D-only session never pays for the 3D runtime.
   * Meshopt is part of the accepted VRM transport surface because production
   * Base Packs use it to keep shared avatar downloads small.
   */
  static async load(options: VrmActorLoadOptions): Promise<VrmActor> {
    if (isSignalAborted(options.signal)) throw cancellationError()
    const [loaderModule, meshoptModule, vrmModule] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
      import('@pixiv/three-vrm'),
    ])
    const loader = new loaderModule.GLTFLoader()
    loader.setMeshoptDecoder(meshoptModule.MeshoptDecoder)
    loader.register((parser) => new vrmModule.VRMLoaderPlugin(parser))
    const key = options.cacheKey ?? options.assetUrl
    const lease = avatarBytes.acquireLease(key, async (signal) => {
      const response = await fetch(options.assetUrl, signal === undefined ? {} : { signal })
      if (!response.ok) throw new Error(`形象文件下载失败（${response.status}）`)
      return await response.arrayBuffer()
    }, () => undefined, options.signal)
    const releaseBytes = () => lease.release()
    const bytes = await lease.promise
    if (isSignalAborted(options.signal)) {
      releaseBytes()
      throw cancellationError()
    }
    const gltf = await loader.parseAsync(bytes.slice(0), baseUrlOf(options.assetUrl)).catch((error: unknown) => {
      releaseBytes()
      throw error
    })
    const vrm = gltf.userData.vrm as VRM | undefined
    if (vrm === undefined) {
      disposeVrmScene(gltf.scene)
      releaseBytes()
      throw new Error('已发布文件不包含 VRM 1.0 角色')
    }
    if (isSignalAborted(options.signal)) {
      disposeVrmScene(gltf.scene)
      releaseBytes()
      throw cancellationError()
    }
    // VRM 0.x models face the opposite direction.
    vrmModule.VRMUtils.rotateVRM0(vrm)
    if (options.assembly !== undefined) {
      applyAvatarAssembly(vrm.scene, options.assembly.pack, options.assembly.plan)
    }
    return new VrmActor(vrm, () => {
      disposeVrmScene(vrm.scene)
      releaseBytes()
    })
  }

  /**
   * Registers declared authored motion. A real VRMA is retargeted by
   * three-vrm-animation; the bundled offline pack uses semantic Humanoid bone
   * tracks and is retargeted by our loader. Procedural bones remain only the
   * fallback for a gesture a pack genuinely does not provide.
   */
  async loadDeclaredMotion(
    library?: Parameters<typeof declaredMotionSources>[0],
  ): Promise<{ registered: number; failures: number }> {
    const sources = declaredMotionSources(library)
    if (sources.length === 0) return { registered: 0, failures: 0 }
    const result = await loadMotionClips(this.vrm, sources)
    if (this.#disposed) {
      result.release()
      return { registered: 0, failures: result.failures.length }
    }
    this.#motionRelease?.()
    this.#motionRelease = undefined
    for (const { gesture, clip } of result.clips) this.#animation.register(gesture, clip)
    if (result.clips.length > 0) this.#motionRelease = result.release
    else result.release()
    return { registered: result.clips.length, failures: result.failures.length }
  }

  /** Wraps an already-loaded VRM, useful for tests and specialized caches. */
  static fromLoaded(vrm: VRM, onDispose?: () => void): VrmActor {
    return new VrmActor(vrm, onDispose)
  }

  /**
   * Advances all additive layers by one frame. Authored animation owns the
   * primary pose; look-at, blink, expression, lip sync and springs remain
   * additive. Procedural primary bone motion runs only when a clip is missing.
   */
  update(deltaMs: number, input: VrmActorUpdateInput): void {
    if (this.#disposed) return
    const delta = Math.min(deltaMs / 1_000, 0.05)
    this.#elapsed += deltaMs
    const face = input.detail?.face ?? true
    const secondary = input.detail?.secondaryMotion ?? true

    this.#animation.setGesture(input.motionCue.gesture)
    this.#animation.update(delta)

    if (secondary && input.animated && !this.#animation.hasGesture(input.motionCue.gesture)) {
      this.#motion.setGesture(input.motionCue.gesture)
      this.#motion.update(this.#elapsed, delta, true)
    }
    if (face) {
      this.#expression.update(input.motionCue.expression, delta)
      this.#lookAt.setLookAt(input.lookAt)
      this.#lookAt.update(input.state, this.#elapsed, delta, input.animated)
      this.#blink.update(this.#elapsed, input.animated)
      this.#speech.update(this.#elapsed, input.speaking, input.amplitude)
    }
    if (secondary || this.#springFrame % 2 === 0) this.vrm.update(delta)
    this.#springFrame += 1
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.root.removeFromParent()
    this.#animation.dispose()
    this.#motionRelease?.()
    this.#motionRelease = undefined
    this.#expression.dispose()
    if (this.#onDispose !== undefined) this.#onDispose()
    else disposeVrmScene(this.root)
  }
}

function cancellationError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('VRM 加载已取消', 'AbortError')
  const error = new Error('VRM 加载已取消')
  error.name = 'AbortError'
  return error
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Where a glTF's relative references resolve against. */
function baseUrlOf(assetUrl: string): string {
  const index = assetUrl.lastIndexOf('/')
  return index < 0 ? '' : assetUrl.slice(0, index + 1)
}
