import { describe, expect, it } from 'vitest'

import {
  assertCharacterBehaviorProfileAppearance,
  characterBehaviorProfileToJson,
  parseCharacterBehaviorProfile,
  readCharacterBehaviorProfile,
} from '../src/character-behavior-profile.js'

describe('custom character behavior profiles', () => {
  it('decodes semantic role configuration without coordinates or built-in role names', () => {
    const profile = parseCharacterBehaviorProfile({
      id: 'user.quantum-gardener',
      roleTags: ['botany', 'experiments'],
      preferredZoneTags: ['research'],
      preferredFacilityCapabilities: ['research', 'inspect'],
      homeSlotTags: ['research', 'work'],
      ambientBehaviors: ['inspect-cultivation-bed'],
      socialPolicy: {
        canInitiateConversation: false,
        cooldownSeconds: 1_800,
        maxDailyConversations: 0,
      },
    })

    expect(profile).toMatchObject({
      id: 'user.quantum-gardener',
      roleTags: ['botany', 'experiments'],
      preferredZoneTags: ['research'],
      homeSlotTags: ['research', 'work'],
      socialPolicy: { canInitiateConversation: false },
    })
    expect(JSON.stringify(profile)).not.toMatch(/coordinate|position|anchor|path/i)
  })

  it('uses safe social defaults and theme-independent allowed zones', () => {
    const profile = parseCharacterBehaviorProfile({
      id: 'user.night-auditor',
      roleTags: ['audit'],
      preferredZoneTags: ['operations'],
      homeSlotTags: ['operations', 'work'],
    })

    expect(profile?.socialPolicy).toEqual({
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    })
    expect(profile?.allowedZoneTags).toContain('custom')
  })

  it('rejects malformed and duplicate semantic tags on writes', () => {
    expect(() => assertCharacterBehaviorProfileAppearance({
      worldBehaviorProfile: {
        id: 'broken',
        roleTags: ['research', 'research'],
        preferredZoneTags: ['research'],
        homeSlotTags: ['work'],
      },
    })).toThrow('duplicate')
    expect(() => parseCharacterBehaviorProfile({
      id: 'broken',
      roleTags: [],
      preferredZoneTags: ['research'],
      homeSlotTags: ['work'],
    })).toThrow('at least one')
  })

  it('falls back safely when legacy appearance contains invalid manual data', () => {
    expect(readCharacterBehaviorProfile({
      worldBehaviorProfile: { id: 42 },
    })).toBeUndefined()
  })

  it('round-trips an explicit profile through JSON appearance storage', () => {
    const parsed = parseCharacterBehaviorProfile({
      id: 'user.media-editor',
      roleTags: ['media', 'editing'],
      preferredZoneTags: ['operations'],
      preferredFacilityCapabilities: ['work', 'editing'],
      allowedZoneTags: ['operations', 'meeting', 'rest', 'public'],
      homeSlotTags: ['operations', 'work'],
      ambientBehaviors: ['review-render-queue'],
      socialPolicy: {
        canInitiateConversation: true,
        cooldownSeconds: 3_600,
        maxDailyConversations: 2,
      },
    })!

    expect(parseCharacterBehaviorProfile(characterBehaviorProfileToJson(parsed))).toEqual(parsed)
  })
})
