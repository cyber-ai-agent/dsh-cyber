import { Euler, Quaternion } from 'three'
import type { VRM } from '@pixiv/three-vrm'

import type { DigitalHumanGesture } from '../../digital-human-motion.js'
import { DEFAULT_MOTION_LIBRARY } from '../motion/MotionLibrary.js'

type BoneName = 'spine' | 'leftUpperArm' | 'rightUpperArm'

export class VrmMotionController {
  readonly #vrm: VRM
  readonly #targets = new Map<BoneName, Quaternion>()
  #gesture: DigitalHumanGesture = 'breathe'
  #transition = 1

  constructor(vrm: VRM) { this.#vrm = vrm }

  setGesture(gesture: DigitalHumanGesture): void {
    if (gesture === this.#gesture) return
    this.#gesture = gesture
    this.#transition = 0
  }

  update(time: number, delta: number, enabled: boolean): void {
    const entry = DEFAULT_MOTION_LIBRARY[this.#gesture]
    this.#transition = Math.min(1, this.#transition + delta / Math.max(0.001, entry.transitionMs / 1_000))
    const phase = enabled ? Math.sin(time / 620) : 0
    const gesture = enabled ? this.#gesture : 'freeze'
    const pose: Record<BoneName, Euler> = {
      spine: new Euler(gesture === 'listen' ? 0.055 : gesture === 'freeze' ? -0.04 : phase * 0.008, 0, 0),
      leftUpperArm: new Euler(gesture === 'present' ? 0.25 : gesture === 'explain' ? 0.16 + phase * 0.05 : 0, 0, gesture === 'present' ? -0.28 : -0.05),
      rightUpperArm: new Euler(gesture === 'explain' ? 0.22 - phase * 0.05 : gesture === 'hold' ? 0.08 : 0, 0, gesture === 'explain' ? 0.22 : 0.05),
    }
    for (const boneName of Object.keys(pose) as BoneName[]) {
      const bone = this.#vrm.humanoid?.getNormalizedBoneNode(boneName)
      if (bone === null || bone === undefined) continue
      const target = this.#targets.get(boneName) ?? new Quaternion()
      target.setFromEuler(pose[boneName])
      this.#targets.set(boneName, target)
      bone.quaternion.slerp(target, Math.min(1, delta * (3 + this.#transition * 4)))
    }
    this.#vrm.scene.position.y = enabled && gesture === 'breathe' ? Math.sin(time / 850) * 0.006 : 0
  }
}
