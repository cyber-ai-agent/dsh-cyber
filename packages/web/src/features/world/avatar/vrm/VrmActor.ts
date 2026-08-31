import type { VRM } from '@pixiv/three-vrm'
import type { Object3D } from 'three'

import type { DigitalHumanMotionCue, DigitalHumanVisualState } from '../../digital-human-motion.js'
import { VrmAnimationController } from './VrmAnimationController.js'
import { VrmBlinkController } from './VrmBlinkController.js'
import { VrmExpressionController } from './VrmExpressionController.js'
import { VrmLookAtController } from './VrmLookAtController.js'
import { VrmMotionController } from './VrmMotionController.js'
import { VrmSpeechController } from './VrmSpeechController.js'
import { disposeVrmScene } from './VrmResourceManager.js'
import { declaredMotionSources, loadMotionClips } from '../motion/load-motion-clips.js'

/**
 * One VRM character, with no opinion about whose scene it is in.
 *
 * `VrmRuntimeRenderer` built a WebGLRenderer, a Scene, a Camera, three lights
 * and its own animation loop around a single avatar. That is why the digital
 * human could only ever be a page of its own: an actor that owns a renderer
 * cannot stand in somebody else's office, and a browser will not give you one
 * context per character anyway.
 *
 * So this owns an `Object3D` and the character's own behaviour, and nothing
 * else. The world scene adds it, positions it, and ticks it; a preview panel
 * can do the same with a scene of its own.
 */

export interface VrmActorLoadOptions {
  assetUrl: string
  /** Named so a cache can share one download between characters. */
  cacheKey?: string
  signal?: AbortSignal
}

export interface VrmActorUpdateInput {
  state: DigitalHumanVisualState
  motionCue: DigitalHumanMotionCue
  speaking: boolean
  /** False freezes secondary motion without tearing the character down. */
  animated: boolean
  /**
   * How much of the character to run.
   *
   * A distant character keeps its pose and its place but stops paying for a
   * face nobody can see. Set from the LOD policy rather than guessed here.
   */
  detail?: { face: boolean; secondaryMotion: boolean }
  /**
   * Speech loudness, 0..1, for lip sync.
   *
   * Optional, and the module-level playback amplitude is the fallback. It
   * exists because a shared scene can have two characters speaking at once —
   * a meeting hand-off, an interruption — and one global figure cannot be the
   * loudness of both. A character that is not speaking has a closed mouth
   * either way.
   */
  amplitude?: number
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
   * Loads a character.
   *
   * Three, the glTF loader and three-vrm are imported here so a world that
   * nobody has asked for a VRM in never pays for them.
   */
  static async load(options: VrmActorLoadOptions): Promise<VrmActor> {
    const [THREE, loaderModule, vrmModule] = await Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
      import('@pixiv/three-vrm'),
    ])
    const loader = new loaderModule.GLTFLoader()
    loader.register((parser) => new vrmModule.VRMLoaderPlugin(parser))
    const gltf = await loader.loadAsync(options.assetUrl)
    const vrm = gltf.userData.vrm as VRM | undefined
    if (vrm === undefined) {
      disposeVrmScene(gltf.scene)
      throw new Error('已发布文件不包含 VRM 1.0 角色')
    }
    if (options.signal?.aborted === true) {
      disposeVrmScene(gltf.scene)
      throw new Error('VRM 加载已取消')
    }
    // VRM 0.x models face the opposite way; without this a character walks
    // backwards through its own office.
    vrmModule.VRMUtils.rotateVRM0(vrm)
    void THREE
    return new VrmActor(vrm)
  }

  /**
   * Registers whatever motion assets the library declares.
   *
   * Silent and harmless when nothing is declared, which is today: the
   * repository ships no animation assets, so the character keeps its
   * procedural layer rather than being given invented keyframes.
   */
  async loadDeclaredMotion(): Promise<{ registered: number; failures: number }> {
    const sources = declaredMotionSources()
    if (sources.length === 0) return { registered: 0, failures: 0 }
    const result = await loadMotionClips(this.vrm, sources)
    if (this.#disposed) return { registered: 0, failures: result.failures.length }
    for (const { gesture, clip } of result.clips) this.#animation.register(gesture, clip)
    return { registered: result.clips.length, failures: result.failures.length }
  }

  /** Wraps an already-loaded VRM, for a cache that hands out shared instances. */
  static fromLoaded(vrm: VRM, onDispose?: () => void): VrmActor {
    return new VrmActor(vrm, onDispose)
  }

  /**
   * Advances the character by one frame.
   *
   * The layers are deliberately additive rather than exclusive: a walking
   * character still turns its head toward whoever is speaking, still blinks,
   * and still moves its mouth. A controller that overwrote the others would
   * make the character look like it could only do one thing at a time.
   */
  update(deltaMs: number, input: VrmActorUpdateInput): void {
    if (this.#disposed) return
    const delta = Math.min(deltaMs / 1_000, 0.05)
    this.#elapsed += deltaMs
    const face = input.detail?.face ?? true
    const secondary = input.detail?.secondaryMotion ?? true

    this.#animation.setGesture(input.motionCue.gesture)
    this.#animation.update(delta)

    if (secondary && input.animated) {
      this.#motion.setGesture(input.motionCue.gesture)
      this.#motion.update(this.#elapsed, delta, true)
    }
    if (face) {
      this.#expression.update(input.motionCue.expression, delta)
      this.#lookAt.update(input.state, this.#elapsed, delta, input.animated)
      this.#blink.update(this.#elapsed, input.animated)
      this.#speech.update(this.#elapsed, input.speaking, input.amplitude)
    }
    // Spring bones are the most expensive part of a VRM and the least missed
    // at a distance; halving their cadence is cheaper than dropping the model.
    if (secondary || this.#springFrame % 2 === 0) this.vrm.update(delta)
    this.#springFrame += 1
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.root.removeFromParent()
    this.#animation.dispose()
    this.#expression.dispose()
    if (this.#onDispose !== undefined) this.#onDispose()
    else disposeVrmScene(this.root)
  }
}
