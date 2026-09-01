import { AnimationClip, Group, Object3D } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VrmActor } from '../src/features/world/avatar/vrm/VrmActor.js'

afterEach(() => vi.unstubAllGlobals())

describe('VrmActor embedded authored motion', () => {
  it('uses a complete embedded gesture set without downloading the generic motion pack', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const actor = VrmActor.fromLoaded(fakeVrm() as never, () => {}, [
      new AnimationClip('Idle_Loop', 1, []),
      new AnimationClip('Walk_Loop', 1, []),
      new AnimationClip('Idle_Talking_Loop', 1, []),
      new AnimationClip('Interact', 1, []),
    ])

    await expect(actor.loadDeclaredMotion()).resolves.toEqual({ registered: 0, failures: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
    actor.dispose()
  })
})

function fakeVrm() {
  const scene = new Group()
  const bones = new Map<string, Object3D>()
  for (const name of ['spine', 'leftUpperArm', 'rightUpperArm', 'head']) {
    const bone = new Object3D()
    bone.name = `bone-${name}`
    scene.add(bone)
    bones.set(name, bone)
  }
  return {
    scene,
    humanoid: {
      getNormalizedBoneNode: (name: string) => bones.get(name),
      getRawBoneNode: () => undefined,
    },
    expressionManager: {
      setValue: () => {},
      getValue: () => 0,
      expressions: [],
      getExpression: () => undefined,
    },
    lookAt: { target: undefined, update: () => {} },
    update: () => {},
  }
}
