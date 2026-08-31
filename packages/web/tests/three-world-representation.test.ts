import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR, LOCAL_PROCEDURAL_AVATAR_AUTHOR } from '../src/features/world/avatar/avatar-origin.js'
import { LowPolyActor } from '../src/features/world/renderer/spatial/low-poly-actor.js'
import { applyActorRepresentation, shouldPreferIdentityPortrait } from '../src/features/world/renderer/spatial/three-world-renderer.js'

describe('three-world actor representation state machine', () => {
  it.each([
    ['full', true, false],
    ['reduced', true, false],
    ['billboard', false, true],
  ] as const)('%s keeps exactly one visible representation for a VRM actor', (lod, vrmVisible, standInVisible) => {
    const standIn = new LowPolyActor({ shadows: false })
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial())
    root.add(mesh)
    root.visible = true

    applyActorRepresentation({ actor: standIn, vrm: { root } }, lod)

    expect(root.visible).toBe(vrmVisible)
    expect(root.visible && mesh.visible).toBe(vrmVisible)
    expect(standIn.representationVisible).toBe(standInVisible)
    expect(Number(root.visible) + Number(standIn.representationVisible)).toBe(1)
    standIn.dispose()
  })

  it('keeps the visible representation while crossing every VRM LOD boundary', () => {
    const standIn = new LowPolyActor({ shadows: false })
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial())
    root.add(mesh)
    const view = { actor: standIn, vrm: { root } }

    for (const [lod, vrmVisible, standInVisible] of [
      ['full', true, false], ['reduced', true, false], ['billboard', false, true], ['full', true, false],
    ] as const) {
      applyActorRepresentation(view, lod)
      expect(root.visible && mesh.visible).toBe(vrmVisible)
      expect(standIn.representationVisible).toBe(standInVisible)
      expect(Number(root.visible && mesh.visible) + Number(standIn.representationVisible)).toBe(1)
    }
    standIn.dispose()
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  })

  it('keeps a no-VRM actor visible at billboard detail', () => {
    const standIn = new LowPolyActor({ shadows: false })

    applyActorRepresentation({ actor: standIn, vrm: undefined }, 'billboard')

    expect(standIn.representationVisible).toBe(true)
    standIn.dispose()
  })

  it('recovers the VRM after a billboard transition', () => {
    const standIn = new LowPolyActor({ shadows: false })
    const root = new THREE.Group()

    applyActorRepresentation({ actor: standIn, vrm: { root } }, 'billboard')
    applyActorRepresentation({ actor: standIn, vrm: { root } }, 'reduced')
    expect(root.visible).toBe(true)
    expect(standIn.representationVisible).toBe(false)
    expect(Number(root.visible) + Number(standIn.representationVisible)).toBe(1)
    standIn.dispose()
  })

  it('keeps 2D identity for generic local drafts but accepts an identity-recipe local VRM', () => {
    expect(shouldPreferIdentityPortrait(true, { meta: { authors: [LOCAL_PROCEDURAL_AVATAR_AUTHOR] } })).toBe(true)
    expect(shouldPreferIdentityPortrait(true, { meta: { authors: [LOCAL_IDENTITY_RECIPE_AVATAR_AUTHOR] } })).toBe(false)
    expect(shouldPreferIdentityPortrait(false, { meta: { authors: [LOCAL_PROCEDURAL_AVATAR_AUTHOR] } })).toBe(false)
  })
})
