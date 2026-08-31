import { Euler, Object3D, Quaternion } from 'three'
import { describe, expect, it } from 'vitest'

import { VrmLookAtController } from '../src/features/world/avatar/vrm/VrmLookAtController.js'

/**
 * A head on a body, in a world.
 *
 * The controller has to turn a world-space point into a head rotation relative
 * to wherever the character is standing and whichever way it is facing, so the
 * test needs a real parent transform rather than a bare bone.
 */
function character(position: { x: number; z: number }, bodyHeading: number) {
  const body = new Object3D()
  body.position.set(position.x, 0, position.z)
  body.rotation.y = bodyHeading
  const head = new Object3D()
  head.position.set(0, 1.5, 0)
  body.add(head)
  body.updateMatrixWorld(true)
  const controller = new VrmLookAtController({
    humanoid: { getNormalizedBoneNode: () => head },
  } as never)
  return { body, head, controller }
}

/** The yaw the controller settled on, in the head's own frame. */
function settledYaw(head: Object3D, controller: VrmLookAtController, state = 'idle' as never): number {
  for (let frame = 0; frame < 120; frame += 1) controller.update(state, frame * 16, 0.016, true)
  return new Euler().setFromQuaternion(head.quaternion.clone().normalize() as Quaternion, 'YXZ').y
}

describe('VrmLookAtController', () => {
  it('turns toward somebody standing to its left', () => {
    const { body, head, controller } = character({ x: 0, z: 0 }, 0)
    body.updateMatrixWorld(true)
    // Facing -z with a target at -x: a positive yaw about +y turns -z toward
    // -x, so the head should rotate positively.
    controller.setLookAt({ x: -5, y: 1.5, z: 0 })
    expect(settledYaw(head, controller)).toBeGreaterThan(0.3)
  })

  it('turns the other way for somebody on its right', () => {
    const { body, head, controller } = character({ x: 0, z: 0 }, 0)
    body.updateMatrixWorld(true)
    controller.setLookAt({ x: 5, y: 1.5, z: 0 })
    expect(settledYaw(head, controller)).toBeLessThan(-0.3)
  })

  it('accounts for which way the body is already facing', () => {
    // The same target, seen by a character turned to face it, needs almost no
    // head turn. Ignoring the body transform would give the same large yaw as
    // the case above and point the head into empty room.
    const { body, head, controller } = character({ x: 0, z: 0 }, -Math.PI / 2)
    body.updateMatrixWorld(true)
    controller.setLookAt({ x: 5, y: 1.5, z: 0 })
    expect(Math.abs(settledYaw(head, controller))).toBeLessThan(0.2)
  })

  it('refuses to turn the head further than a person would', () => {
    const { body, head, controller } = character({ x: 0, z: 0 }, 0)
    body.updateMatrixWorld(true)
    // Directly behind. A person steps round; a neck that goes there is the
    // owl-head look that makes a character read as a puppet.
    controller.setLookAt({ x: 0, y: 1.5, z: 10 })
    expect(Math.abs(settledYaw(head, controller))).toBeLessThanOrEqual(0.71)
  })

  it('wanders when there is nobody to look at', () => {
    const { body, head, controller } = character({ x: 0, z: 0 }, 0)
    body.updateMatrixWorld(true)
    const samples = new Set<number>()
    for (let frame = 0; frame < 400; frame += 1) {
      controller.update('idle' as never, frame * 40, 0.04, true)
      samples.add(Math.round(new Euler().setFromQuaternion(head.quaternion, 'YXZ').y * 100))
    }
    // A head that stops dead reads as more broken than one that drifts.
    expect(samples.size).toBeGreaterThan(3)
  })

  it('goes back to wandering when the target is taken away', () => {
    const { body, head, controller } = character({ x: 0, z: 0 }, 0)
    body.updateMatrixWorld(true)
    controller.setLookAt({ x: -5, y: 1.5, z: 0 })
    const aimed = settledYaw(head, controller)
    controller.setLookAt(undefined)
    for (let frame = 0; frame < 200; frame += 1) controller.update('idle' as never, frame * 40, 0.04, true)
    expect(new Euler().setFromQuaternion(head.quaternion, 'YXZ').y).not.toBeCloseTo(aimed, 2)
  })

  it('survives a character with no head bone', () => {
    const controller = new VrmLookAtController({ humanoid: { getNormalizedBoneNode: () => null } } as never)
    controller.setLookAt({ x: 1, y: 1, z: 1 })
    expect(() => controller.update('idle' as never, 0, 0.016, true)).not.toThrow()
  })
})
