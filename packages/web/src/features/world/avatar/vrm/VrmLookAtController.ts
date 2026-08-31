import { Euler, Quaternion, Vector3 } from 'three'
import type { VRM } from '@pixiv/three-vrm'

import type { DigitalHumanVisualState } from '../../digital-human-motion.js'

/**
 * Where a character is looking.
 *
 * Without a target this is a wander: a sine on the neck, aimed at nobody. That
 * is the right answer for a character alone on a preview stage, and the wrong
 * one in a room — a meeting where everybody stares straight ahead reads as
 * eight people ignoring each other.
 *
 * So a target may be given, in world space. It is turned into a head rotation
 * relative to wherever the character is standing and whichever way it is
 * facing, and approached rather than snapped to.
 */
export class VrmLookAtController {
  readonly #head: import('three').Object3D | null
  readonly #target = new Quaternion()
  readonly #euler = new Euler(0, 0, 0, 'YXZ')
  readonly #worldPosition = new Vector3()
  #lookAt: Vector3 | undefined

  constructor(vrm: VRM) { this.#head = vrm.humanoid?.getNormalizedBoneNode('head') ?? null }

  /**
   * Something worth looking at, in world space — the speaker, or the viewer.
   *
   * `undefined` returns the character to its idle wander rather than freezing
   * it, because a head that stops dead is more obviously wrong than one that
   * drifts.
   */
  setLookAt(target: { x: number; y: number; z: number } | undefined): void {
    if (target === undefined) {
      this.#lookAt = undefined
      return
    }
    this.#lookAt ??= new Vector3()
    this.#lookAt.set(target.x, target.y, target.z)
  }

  update(state: DigitalHumanVisualState, time: number, delta: number, enabled: boolean): void {
    const head = this.#head
    if (head === null) return
    const aim = this.#aim(head, state, time, enabled)
    this.#euler.set(aim.pitch, aim.yaw, 0, 'YXZ')
    this.#target.setFromEuler(this.#euler)
    // Eye contact settles faster than a wander: looking up when somebody
    // starts talking should feel like a response, not a drift.
    const rate = this.#lookAt === undefined ? 3.5 : 6
    head.quaternion.slerp(this.#target, Math.min(1, delta * rate))
  }

  #aim(
    head: import('three').Object3D,
    state: DigitalHumanVisualState,
    time: number,
    enabled: boolean,
  ): { yaw: number; pitch: number } {
    const target = this.#lookAt
    if (target !== undefined) {
      head.getWorldPosition(this.#worldPosition)
      const dx = target.x - this.#worldPosition.x
      const dy = target.y - this.#worldPosition.y
      const dz = target.z - this.#worldPosition.z
      const flat = Math.hypot(dx, dz)
      // The head turns; the body does not. Beyond about a quarter turn a
      // person would step round instead, and forcing the neck there is the
      // owl-head look that makes a character read as a puppet.
      const yaw = clamp(normalizeAngle(Math.atan2(-dx, -dz) - worldYaw(head)), -0.7, 0.7)
      const pitch = clamp(Math.atan2(dy, Math.max(flat, 0.001)), -0.35, 0.35)
      return { yaw, pitch }
    }
    if (!enabled) return { yaw: 0, pitch: 0 }
    const strength = state === 'speaking' ? 0.35 : state === 'thinking' ? 0.14 : 0.2
    return {
      yaw: Math.sin(time / (state === 'thinking' ? 1_700 : 2_900)) * strength,
      pitch: state === 'thinking' ? 0.09 : Math.sin(time / 3_700) * 0.035,
    }
  }
}

function worldYaw(object: import('three').Object3D): number {
  const parent = object.parent
  return parent === null ? 0 : new Euler().setFromQuaternion(parent.getWorldQuaternion(new Quaternion()), 'YXZ').y
}

function normalizeAngle(angle: number): number {
  const wrapped = (angle + Math.PI) % (Math.PI * 2)
  return (wrapped < 0 ? wrapped + Math.PI * 2 : wrapped) - Math.PI
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
