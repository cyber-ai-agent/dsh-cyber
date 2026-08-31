import { describe, expect, it, vi } from 'vitest'

import { VrmActor, type VrmActorUpdateInput } from '../src/features/world/avatar/vrm/VrmActor.js'

/**
 * A VRM stand-in.
 *
 * The controllers only ever touch the humanoid, the expression manager and the
 * scene graph, so a shape carrying those is enough to drive a real actor
 * without a WebGL context — which is the property the extraction was for.
 */
function fakeVrm() {
  const updates: number[] = []
  const scene = {
    name: 'vrm-root',
    parent: null as unknown,
    children: [] as unknown[],
    position: { set: () => {} },
    rotation: { y: 0 },
    removeFromParent() { this.parent = null },
    traverse(visit: (node: unknown) => void) { visit(this) },
  }
  return {
    scene,
    humanoid: {
      getNormalizedBoneNode: () => ({
        position: { set: () => {}, x: 0, y: 0, z: 0 },
        rotation: { set: () => {}, x: 0, y: 0, z: 0 },
        quaternion: { slerp: () => {}, setFromEuler: () => {} },
      }),
      getRawBoneNode: () => undefined,
    },
    expressionManager: {
      setValue: () => {},
      getValue: () => 0,
      expressions: [],
      getExpression: () => undefined,
    },
    lookAt: { target: undefined, update: () => {} },
    update: (delta: number) => { updates.push(delta) },
    updates,
  }
}

function input(overrides: Partial<VrmActorUpdateInput> = {}): VrmActorUpdateInput {
  return {
    state: 'idle',
    motionCue: { gesture: 'breathe', expression: 'neutral' },
    speaking: false,
    animated: true,
    ...overrides,
  } as VrmActorUpdateInput
}

describe('VrmActor', () => {
  it('owns an object, not a renderer', () => {
    const vrm = fakeVrm()
    const actor = VrmActor.fromLoaded(vrm as never)
    // The whole point of the extraction: an actor that built its own
    // WebGLRenderer could never stand in somebody else's office, and a browser
    // will not hand out one context per character.
    expect(actor.root).toBe(vrm.scene)
    expect(actor).not.toHaveProperty('renderer')
    expect(actor).not.toHaveProperty('camera')
    expect(actor).not.toHaveProperty('scene')
  })

  it('advances the character on update', () => {
    const vrm = fakeVrm()
    const actor = VrmActor.fromLoaded(vrm as never)
    actor.update(16, input())
    expect(vrm.updates.length).toBeGreaterThan(0)
  })

  it('clamps a long frame so a stalled tab does not lurch', () => {
    const vrm = fakeVrm()
    const actor = VrmActor.fromLoaded(vrm as never)
    actor.update(5_000, input())
    expect(vrm.updates.at(-1)).toBeLessThanOrEqual(0.05)
  })

  it('halves spring cadence when secondary motion is cut', () => {
    const vrm = fakeVrm()
    const actor = VrmActor.fromLoaded(vrm as never)
    for (let index = 0; index < 8; index += 1) {
      actor.update(16, input({ detail: { face: false, secondaryMotion: false } }))
    }
    // Spring bones are the most expensive part of a VRM and the least missed
    // from across a room.
    expect(vrm.updates.length).toBeLessThan(8)
    expect(vrm.updates.length).toBeGreaterThan(0)
  })

  it('keeps every layer running at once', () => {
    // Walking, looking at somebody, blinking and speaking have to be able to
    // happen together; a controller that overwrote the others would make the
    // character look like it could only do one thing at a time.
    const vrm = fakeVrm()
    const expressionSpy = vi.spyOn(vrm.expressionManager, 'setValue')
    const actor = VrmActor.fromLoaded(vrm as never)
    actor.update(16, input({ speaking: true }))
    expect(vrm.updates.length).toBe(1)
    expect(expressionSpy).toHaveBeenCalled()
  })

  it('stops paying for a face nobody can see', () => {
    const vrm = fakeVrm()
    const expressionSpy = vi.spyOn(vrm.expressionManager, 'setValue')
    const actor = VrmActor.fromLoaded(vrm as never)
    actor.update(16, input({ speaking: true, detail: { face: false, secondaryMotion: true } }))
    expect(expressionSpy).not.toHaveBeenCalled()
  })

  it('detaches itself from whatever scene it was in', () => {
    const vrm = fakeVrm()
    vrm.scene.parent = { name: 'world' }
    const actor = VrmActor.fromLoaded(vrm as never, () => {})
    actor.dispose()
    expect(vrm.scene.parent).toBeNull()
  })

  it('runs the caller disposer instead of freeing a shared model', () => {
    // A cache hands the same VRM to several characters; freeing its geometry
    // when one of them leaves would empty the others.
    const release = vi.fn()
    const actor = VrmActor.fromLoaded(fakeVrm() as never, release)
    actor.dispose()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('ignores work after disposal', () => {
    const vrm = fakeVrm()
    const actor = VrmActor.fromLoaded(vrm as never, () => {})
    actor.dispose()
    const before = vrm.updates.length
    actor.update(16, input())
    actor.dispose()
    expect(vrm.updates.length).toBe(before)
  })
})
