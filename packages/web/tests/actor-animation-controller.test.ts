import { Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import type { WorldActivityKind, WorldFacing, WorldThemeActorSetManifest } from '@dsh-cyber/contracts'

import { ActorAnimationController } from '../src/features/world/renderer/actor-animation-controller.js'

const activities: WorldActivityKind[] = [
  'idle', 'walking', 'thinking', 'working', 'talking', 'meeting', 'blocked', 'celebrating',
]
const facings: WorldFacing[] = ['north', 'east', 'south', 'west']

describe('ActorAnimationController', () => {
  it('keeps texture allocation bounded during long-running state changes', () => {
    const clips = Object.fromEntries(activities.map((activity, index) => [activity, {
      north: [index],
      east: [index],
      south: [index],
      west: [index],
    }])) as WorldThemeActorSetManifest['clips']
    const actorSet: WorldThemeActorSetManifest = {
      id: 'soak',
      assetId: 'texture',
      frameWidth: 1,
      frameHeight: 1,
      framesPerActor: 8,
      scale: 1,
      footOffset: { x: 0, y: 1 },
      clips,
    }
    const controller = new ActorAnimationController(Texture.WHITE, actorSet, 0)
    for (let index = 0; index < 10_000; index += 1) {
      controller.setState(activities[index % activities.length]!, facings[index % facings.length]!)
      controller.tick(16)
    }
    expect(controller.textureCount).toBeLessThanOrEqual(activities.length)
    controller.destroy()
    expect(controller.textureCount).toBe(0)
  })
})
