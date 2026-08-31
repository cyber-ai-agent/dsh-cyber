import { describe, expect, it } from 'vitest'

import { identityPortraitFrame } from '../src/features/world/renderer/spatial/low-poly-actor.js'
import { isGenericProceduralVrm, shouldPreferIdentityPortrait } from '../src/features/world/renderer/spatial/three-world-renderer.js'

describe('3D character identity continuity', () => {
  it('crops the same actor slot from the 2D roster atlas', () => {
    expect(identityPortraitFrame(1536, 1024, {
      src: '/themes/cyber-company/employee-roster-transparent.webp',
      frameWidth: 384,
      frameHeight: 512,
      framesPerActor: 1,
      rosterIndex: 5,
    })).toEqual({
      repeatX: 0.25,
      repeatY: 0.5,
      offsetX: 0.25,
      offsetY: 0,
      aspect: 0.75,
    })
  })

  it('wraps a roster index the same way as the 2D actor selection', () => {
    const first = identityPortraitFrame(1536, 1024, {
      src: '/roster.webp', frameWidth: 384, frameHeight: 512, rosterIndex: 1,
    })
    const wrapped = identityPortraitFrame(1536, 1024, {
      src: '/roster.webp', frameWidth: 384, frameHeight: 512, rosterIndex: 9,
    })
    expect(wrapped).toEqual(first)
  })

  it('recognises only the built-in procedural generator as a generic 3D draft', () => {
    expect(isGenericProceduralVrm({ meta: { authors: ['DSH Cyber 本机创建器'] } })).toBe(true)
    expect(isGenericProceduralVrm({ meta: { authors: ['用户导入', 'Ready Player Me'] } })).toBe(false)
    expect(isGenericProceduralVrm({})).toBe(false)
  })

  it('keeps the recognisable 2D identity instead of replacing it with a generic draft', () => {
    const generic = { meta: { authors: ['DSH Cyber 本机创建器'] } }
    const authored = { meta: { authors: ['角色美术资产包'] } }

    expect(shouldPreferIdentityPortrait(true, generic)).toBe(true)
    expect(shouldPreferIdentityPortrait(true, authored)).toBe(false)
    expect(shouldPreferIdentityPortrait(false, generic)).toBe(false)
  })
})
