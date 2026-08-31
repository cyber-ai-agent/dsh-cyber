import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Texture } from 'three'
import { describe, expect, it, vi } from 'vitest'

import type { CharacterAvatarProfile } from '@dsh-cyber/contracts'
import type { CyberEmployee } from '../src/types.js'
import { readCharacterAvatarProfile } from '../src/features/world/character-avatar-profile.js'
import { registeredRendererIds, selectRenderer } from '../src/features/world/avatar/renderer/RendererRegistry.js'
import { nextLowerQuality } from '../src/features/world/avatar/renderer/RenderingQuality.js'
import { disposeVrmScene } from '../src/features/world/avatar/vrm/VrmResourceManager.js'

describe('digital human renderer registry', () => {
  it('selects VRM only for a published VRM profile and keeps static sprite fallback', () => {
    const profile: CharacterAvatarProfile = { schemaVersion: 1, identityId: 'employee-1', rendererKind: 'vrm-3d', assetId: 'avatar-vrm', sourceName: 'employee.vrm', fallbackAvatarIndex: 2, capabilities: ['full-body'], publishedAt: '2026-08-30T00:00:00.000Z' }
    const employee = { id: 'employee-1', avatarIndex: 2, avatarProfile: profile, avatarAssetUrl: '/api/assets/avatar-vrm' } as CyberEmployee
    expect(selectRenderer(employee, 'balanced').kind).toBe('vrm-3d')
    expect(selectRenderer(employee, 'balanced', 'sprite-2d').kind).toBe('sprite-2d')
    expect(selectRenderer(employee, 'balanced', 'vrm-3d').kind).toBe('vrm-3d')
    expect(selectRenderer(employee, 'static').kind).toBe('sprite-2d')
    expect(selectRenderer({ ...employee, avatarAssetUrl: undefined }, 'high').kind).toBe('sprite-2d')
    expect(registeredRendererIds()).toEqual(['dsh.vrm-3d', 'dsh.sprite-2d'])
    expect(registeredRendererIds().some((id) => /heygen|liveavatar/iu.test(id))).toBe(false)
  })

  it('parses only durable profile descriptors and degrades quality predictably', () => {
    expect(readCharacterAvatarProfile({ schemaVersion: 1, identityId: 'employee-1', rendererKind: 'vrm-3d', assetId: 'a', sourceName: 'a.vrm', fallbackAvatarIndex: 1, capabilities: [], publishedAt: '2026-08-30T00:00:00.000Z' })).toMatchObject({ assetId: 'a' })
    expect(readCharacterAvatarProfile({ schemaVersion: 1, rendererKind: 'mesh-preview', assetId: 'a' })).toBeUndefined()
    expect(['balanced', 'low', 'static'].reduce((value) => nextLowerQuality(value), 'high' as const)).toBe('static')
  })

  it('disposes geometry, material and textures when a VRM runtime unmounts', () => {
    const texture = new Texture()
    const geometry = new BoxGeometry()
    const material = new MeshStandardMaterial({ map: texture })
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')
    const root = new Object3D()
    root.add(new Mesh(geometry, material), new Mesh(geometry, material))
    disposeVrmScene(root)
    expect(geometryDispose).toHaveBeenCalledOnce()
    expect(materialDispose).toHaveBeenCalledOnce()
    expect(textureDispose).toHaveBeenCalledOnce()
  })
})
