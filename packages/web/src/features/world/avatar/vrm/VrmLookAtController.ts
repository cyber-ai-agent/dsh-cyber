import { Euler, Quaternion } from 'three'
import type { VRM } from '@pixiv/three-vrm'

import type { DigitalHumanVisualState } from '../../digital-human-motion.js'

export class VrmLookAtController {
  readonly #head: import('three').Object3D | null
  readonly #target = new Quaternion()

  constructor(vrm: VRM) { this.#head = vrm.humanoid?.getNormalizedBoneNode('head') ?? null }

  update(state: DigitalHumanVisualState, time: number, delta: number, enabled: boolean): void {
    if (this.#head === null) return
    const strength = state === 'speaking' ? 0.35 : state === 'thinking' ? 0.14 : 0.2
    const yaw = enabled ? Math.sin(time / (state === 'thinking' ? 1_700 : 2_900)) * strength : 0
    const pitch = enabled ? (state === 'thinking' ? 0.09 : Math.sin(time / 3_700) * 0.035) : 0
    this.#target.setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'))
    this.#head.quaternion.slerp(this.#target, Math.min(1, delta * 3.5))
  }
}
