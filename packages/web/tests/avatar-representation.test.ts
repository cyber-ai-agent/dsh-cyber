import { describe, expect, it } from 'vitest'

import type { AvatarBasePackManifest } from '../src/features/world/avatar/avatar-base-pack.js'
import {
  MIN_PRODUCTION_AVATAR_IDENTITY_SCORE,
  avatarPackIdentityMatch,
  bestAvatarPackMatch,
  resolveCharacterAvatarRepresentation,
} from '../src/features/world/avatar/avatar-representation.js'
import { parseAvatarRecipe } from '../src/features/world/avatar/avatar-recipe.js'

const matchingPack: AvatarBasePackManifest = {
  schemaVersion: 1,
  id: 'studio-v1',
  version: '1.0.0',
  displayName: 'Studio Avatar Pack',
  license: 'CC0-1.0',
  publisher: 'test',
  quality: 'production',
  bases: [
    { baseModel: 'female-a', assetUrl: '/assets/avatars/female.vrm' },
    { baseModel: 'neutral-a', assetUrl: '/assets/avatars/neutral.vrm' },
  ],
  parts: [
    { id: 'long-layered', kind: 'hair', meshNames: ['Hair_Long'] },
    { id: 'professional', kind: 'outfit', meshNames: ['Outfit_Professional'] },
    // Intentional cross-kind id collision. Selecting hair must not enable this.
    { id: 'long-layered', kind: 'outfit', meshNames: ['Outfit_Collision'] },
    { id: 'glasses', kind: 'accessory', meshNames: ['Accessory_Glasses'] },
  ],
  materialSlots: [
    { id: 'skin', materialNames: ['Skin'] },
    { id: 'hair', materialNames: ['Hair'] },
    { id: 'outfit', materialNames: ['Outfit'] },
    { id: 'accent', materialNames: ['Accent'] },
  ],
}

const violetProfessional = parseAvatarRecipe({
  baseModel: 'female-a',
  build: 'balanced',
  hair: 'long-layered',
  hairColor: '#7c3aed',
  skinTone: '#d9a67f',
  outfit: 'professional',
  outfitColor: '#4338ca',
  accentColor: '#c4b5fd',
})

describe('avatar production representation', () => {
  it('accepts a production pack only when critical identity traits match', () => {
    const match = avatarPackIdentityMatch(matchingPack, violetProfessional)
    expect(match.eligible).toBe(true)
    expect(match.score).toBeGreaterThanOrEqual(MIN_PRODUCTION_AVATAR_IDENTITY_SCORE)
    expect(match.criticalMissing).toEqual([])
    expect(match.plan.visibleMeshNames).toContain('Hair_Long')
    expect(match.plan.visibleMeshNames).toContain('Outfit_Professional')
    expect(match.plan.visibleMeshNames).not.toContain('Outfit_Collision')
  })

  it('rejects a detailed pack that cannot reproduce the character hair', () => {
    const recipe = parseAvatarRecipe({ ...violetProfessional, hair: 'bob' })
    const match = avatarPackIdentityMatch(matchingPack, recipe)
    expect(match.eligible).toBe(false)
    expect(match.criticalMissing).toEqual(['hair:bob'])
  })

  it('rejects a detailed pack that cannot reproduce the character outfit', () => {
    const recipe = parseAvatarRecipe({ ...violetProfessional, outfit: 'analyst' })
    const match = avatarPackIdentityMatch(matchingPack, recipe)
    expect(match.eligible).toBe(false)
    expect(match.criticalMissing).toEqual(['outfit:analyst'])
  })

  it('treats unavailable accessories as optional rather than silently inventing them', () => {
    const recipe = parseAvatarRecipe({ ...violetProfessional, accessoryIds: ['badge'] })
    const match = avatarPackIdentityMatch(matchingPack, recipe)
    expect(match.criticalMissing).toEqual([])
    expect(match.optionalMissing).toContain('accessory:badge')
    expect(match.score).toBeLessThan(1)
  })

  it('never selects a preview pack for the live world', () => {
    const preview: AvatarBasePackManifest = { ...matchingPack, id: 'preview', quality: 'preview' }
    expect(bestAvatarPackMatch(violetProfessional, [preview])).toBeUndefined()
  })

  it('chooses the best identity match rather than the first registered pack', () => {
    const incomplete: AvatarBasePackManifest = {
      ...matchingPack,
      id: 'aaa-incomplete',
      parts: matchingPack.parts.filter((part) => part.kind !== 'hair'),
    }
    const match = bestAvatarPackMatch(violetProfessional, [incomplete, matchingPack])
    expect(match?.pack.id).toBe('studio-v1')
    expect(match?.eligible).toBe(true)
  })

  it('keeps an employee-specific published VRM above every shared Base Pack', () => {
    const representation = resolveCharacterAvatarRepresentation({
      employeeId: 'employee-1',
      gender: 'female',
      fallbackAvatarIndex: 0,
      publishedAvatarUrl: '/api/assets/employee-1.vrm',
    }, [matchingPack])
    expect(representation).toMatchObject({
      source: 'published',
      assetUrl: '/api/assets/employee-1.vrm',
    })
  })

  it('uses a matching pack when no employee-specific VRM exists', () => {
    const representation = resolveCharacterAvatarRepresentation({
      employeeId: 'employee-1',
      gender: 'female',
      fallbackAvatarIndex: 0,
    }, [matchingPack])
    expect(representation?.source).toBe('base-pack')
    expect(representation?.assetUrl).toBe('/assets/avatars/female.vrm')
    expect(representation?.assembly?.plan.visibleMeshNames).toContain('Hair_Long')
    expect(representation?.identityScore).toBeGreaterThanOrEqual(MIN_PRODUCTION_AVATAR_IDENTITY_SCORE)
  })

  it('returns no 3D replacement instead of showing a high-quality stranger', () => {
    const incompatible: AvatarBasePackManifest = {
      ...matchingPack,
      id: 'wrong-hair',
      parts: matchingPack.parts.filter((part) => part.kind !== 'hair'),
    }
    const representation = resolveCharacterAvatarRepresentation({
      employeeId: 'employee-1',
      gender: 'female',
      fallbackAvatarIndex: 0,
    }, [incompatible])
    expect(representation).toBeUndefined()
  })
})
