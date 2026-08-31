import { describe, expect, it } from 'vitest'

import type { CyberEmployee } from '../src/types.js'
import { characterModeAfterMap, hasInteractiveVrm, threeDimensionalControl } from '../src/features/world/avatar/avatar-view-mode.js'

describe('avatar view mode', () => {
  it('requires a published full-body VRM asset for interactive 3D', () => {
    expect(hasInteractiveVrm(employee())).toBe(false)
    expect(hasInteractiveVrm(employee({ avatarAssetUrl: '/api/assets/vrm', avatarProfile: vrmProfile() }))).toBe(true)
    expect(hasInteractiveVrm(employee({ avatarAssetUrl: '/api/assets/vrm', avatarProfile: { ...vrmProfile(), capabilities: ['portrait'] } }))).toBe(false)
  })

  it('keeps the last character mode when returning from the map', () => {
    expect(characterModeAfterMap('3d')).toBe('3d')
    expect(characterModeAfterMap('2d')).toBe('2d')
  })

  it('offers 3D whether or not the character has an avatar', () => {
    // The control switches renderers; it stopped opening the avatar editor
    // once the world learned to draw a character that has none. Labelling it
    // "创建 3D" promised an action it no longer performs.
    const without = threeDimensionalControl(employee())
    expect(without.label).toBe('3D')
    expect(without.title).toContain('还没有 3D 形象')
    expect(without.title).toContain('默认形象')

    const with3d = threeDimensionalControl(employee({ avatarAssetUrl: '/api/assets/vrm', avatarProfile: vrmProfile() }))
    expect(with3d).toMatchObject({ available: true, label: '3D' })
  })
})

function employee(overrides: Partial<CyberEmployee> = {}): CyberEmployee {
  return {
    id: 'employee', workspaceId: 'workspace', worldId: 'world', blueprintId: 'blueprint', blueprintVersion: 1,
    displayName: '测试角色', role: '工程师', status: 'available', currentRevision: 1, createdAt: '', updatedAt: '',
    avatarIndex: 0, presence: 'idle', health: 'healthy', authorityRole: 'member',
    ...overrides,
  }
}

function vrmProfile(): NonNullable<CyberEmployee['avatarProfile']> {
  return {
    schemaVersion: 1, identityId: 'identity', rendererKind: 'vrm-3d', assetId: 'asset', sourceName: 'avatar.vrm', fallbackAvatarIndex: 0,
    capabilities: ['portrait', 'full-body', 'expression', 'viseme', 'gesture', 'look-at'], publishedAt: '',
  }
}
