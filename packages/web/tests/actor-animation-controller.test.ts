import { Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import type { WorldActivityKind, WorldFacing, WorldThemeActorSetManifest } from '@dsh-cyber/contracts'

import { ActorAnimationController } from '../src/features/world/renderer/actor-animation-controller.js'

const activities: WorldActivityKind[] = [
  'idle', 'walking', 'thinking', 'working', 'talking', 'meeting', 'blocked', 'celebrating',
]
const facings: WorldFacing[] = ['north', 'east', 'south', 'west']

function actorSet(framesPerActor = 1): WorldThemeActorSetManifest {
  const clips = Object.fromEntries(activities.map((activity, index) => [activity, {
    north: [index % framesPerActor],
    east: [index % framesPerActor],
    south: [index % framesPerActor],
    west: [index % framesPerActor],
  }])) as WorldThemeActorSetManifest['clips']
  return {
    id: 'reusable-role-body',
    assetId: 'texture',
    frameWidth: 1,
    frameHeight: 1,
    framesPerActor,
    scale: 1,
    footOffset: { x: 0, y: 1 },
    clips,
  }
}

describe('ActorAnimationController', () => {
  it('keeps texture allocation bounded during long-running state changes', () => {
    const controller = new ActorAnimationController(Texture.WHITE, actorSet(8), 0, {
      characterId: 'custom-role-instance',
    })
    for (let index = 0; index < 10_000; index += 1) {
      controller.setState(activities[index % activities.length]!, facings[index % facings.length]!)
      controller.tick(16)
    }
    expect(controller.textureCount).toBeLessThanOrEqual(activities.length)
    controller.destroy()
    expect(controller.textureCount).toBe(0)
  })

  it('animates an arbitrary custom character without inspecting its role or blueprint', () => {
    const controller = new ActorAnimationController(Texture.WHITE, actorSet(), 0, {
      characterId: 'user.custom.quantum-gardener',
      motionProfileId: 'energetic',
    })
    controller.setState('talking', 'east')
    controller.tick(0)
    const first = transform(controller)
    controller.tick(137)
    const second = transform(controller)

    expect(second).not.toEqual(first)
    expect(second.scaleX).toBeGreaterThan(0)
    controller.destroy()
  })

  it('honors reduced motion while retaining the requested facing', () => {
    const controller = new ActorAnimationController(Texture.WHITE, actorSet(), 0, {
      characterId: 'user.custom.accessible-role',
      reducedMotion: true,
    })
    controller.setState('walking', 'west')
    controller.tick(300)

    expect(transform(controller)).toEqual({
      x: 0,
      y: 0,
      rotation: 0,
      alpha: 1,
      scaleX: -1,
      scaleY: 1,
    })
    controller.destroy()
  })
})

function transform(controller: ActorAnimationController) {
  return {
    x: controller.sprite.x,
    y: controller.sprite.y,
    rotation: controller.sprite.rotation,
    alpha: controller.sprite.alpha,
    scaleX: controller.sprite.scale.x,
    scaleY: controller.sprite.scale.y,
  }
}
