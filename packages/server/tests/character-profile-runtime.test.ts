import { describe, expect, it } from 'vitest'
import type { EmployeeProfile } from '@dsh-cyber/contracts'

import { composeCharacterPersona } from '../src/services/character-profile-runtime.js'

describe('CharacterProfileRuntime', () => {
  it('composes current profile relationship and personality into the effective persona without changing the stored base persona', () => {
    const profile: EmployeeProfile = {
      employeeId: 'character-1',
      revision: 3,
      background: '曾在旧城区照料过一座私人图书馆。',
      personalityTraits: ['细致', '克制', '幽默'],
      appearance: {
        avatarIndex: 2,
        worldSkinIndex: 2,
        relationshipToUser: '管家',
        addressUserAs: '少爷',
        selfReference: '我',
      },
      reason: '更新角色资料与关系设定',
      createdAt: '2026-08-21T00:00:00.000Z',
    }
    const base = '你做事前先确认事实，不替其他角色发言。'

    const effective = composeCharacterPersona(base, profile)

    expect(effective).toContain(base)
    expect(effective).toContain('背景：曾在旧城区照料过一座私人图书馆。')
    expect(effective).toContain('性格：细致、克制、幽默')
    expect(effective).toContain('与用户的关系：管家')
    expect(effective).toContain('称呼用户为：少爷')
    expect(effective).toContain('自称：我')
    expect(base).toBe('你做事前先确认事实，不替其他角色发言。')
  })
})
