import { AnimationMixer, type AnimationAction, type AnimationClip, type Object3D } from 'three'

import type { DigitalHumanGesture } from '../../digital-human-motion.js'
import { DEFAULT_MOTION_LIBRARY } from '../motion/MotionLibrary.js'

export class VrmAnimationController {
  readonly #mixer: AnimationMixer
  readonly #actions = new Map<DigitalHumanGesture, AnimationAction>()
  #current: AnimationAction | undefined

  constructor(root: Object3D) { this.#mixer = new AnimationMixer(root) }

  register(gesture: DigitalHumanGesture, clip: AnimationClip): void {
    this.#actions.set(gesture, this.#mixer.clipAction(clip))
  }

  hasGesture(gesture: DigitalHumanGesture): boolean {
    return this.#actions.has(gesture)
  }

  setGesture(gesture: DigitalHumanGesture): void {
    const next = this.#actions.get(gesture)
    if (next === this.#current) return
    const duration = DEFAULT_MOTION_LIBRARY[gesture].transitionMs / 1_000
    if (next === undefined) {
      // A missing authored gesture means the procedural controller owns the
      // primary pose. Do not leave the previous authored walk/talk looping
      // underneath it forever.
      this.#current?.fadeOut(duration)
      this.#current = undefined
      return
    }
    next.reset().play()
    if (this.#current !== undefined) this.#current.crossFadeTo(next, duration, true)
    else next.fadeIn(duration)
    this.#current = next
  }

  update(delta: number): void { this.#mixer.update(delta) }
  dispose(): void { this.#mixer.stopAllAction(); this.#actions.clear(); this.#current = undefined }
}
