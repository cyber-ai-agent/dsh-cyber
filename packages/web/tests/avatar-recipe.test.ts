import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AVATAR_RECIPE,
  avatarBaseKey,
  avatarRecipeForCharacter,
  parseAvatarRecipe,
  sameAvatarRecipe,
} from '../src/features/world/avatar/avatar-recipe.js'

describe('parseAvatarRecipe', () => {
  it('reads a complete recipe', () => {
    expect(parseAvatarRecipe({
      schemaVersion: 1,
      baseModel: 'female-a',
      build: 'slender',
      hair: 'bob',
      hairColor: '#2A1B10',
      skinTone: '#e8c39e',
      outfit: 'blazer',
      outfitColor: '#1f2a37',
      accentColor: '#7c3aed',
      accessoryIds: ['glasses', 'badge'],
    })).toEqual({
      schemaVersion: 1,
      baseModel: 'female-a',
      build: 'slender',
      hair: 'bob',
      hairColor: '#2a1b10',
      skinTone: '#e8c39e',
      outfit: 'blazer',
      outfitColor: '#1f2a37',
      accentColor: '#7c3aed',
      accessoryIds: ['glasses', 'badge'],
    })
  })

  it('gives a character an appearance rather than an error', () => {
    expect(parseAvatarRecipe(undefined)).toEqual(DEFAULT_AVATAR_RECIPE)
    expect(parseAvatarRecipe('nonsense')).toEqual(DEFAULT_AVATAR_RECIPE)
    expect(parseAvatarRecipe([])).toEqual(DEFAULT_AVATAR_RECIPE)
    expect(parseAvatarRecipe({ baseModel: 'dragon' })).toEqual(DEFAULT_AVATAR_RECIPE)
  })

  it('refuses anything that is not a colour where a colour goes', () => {
    const recipe = parseAvatarRecipe({
      baseModel: 'neutral-a',
      hairColor: 'url(http://example.com/x.png)',
      skinTone: 'red',
      outfitColor: '#12345',
      accentColor: 'linear-gradient(red, blue)',
    })
    expect(recipe.hairColor).toBeUndefined()
    expect(recipe.skinTone).toBeUndefined()
    expect(recipe.outfitColor).toBeUndefined()
    expect(recipe.accentColor).toBeUndefined()
  })

  it('bounds what a recipe can carry', () => {
    const recipe = parseAvatarRecipe({
      baseModel: 'robot-a',
      hair: 'x'.repeat(500),
      accessoryIds: Array.from({ length: 40 }, (_item, index) => `item-${index}`),
    })
    expect(recipe.hair!.length).toBeLessThanOrEqual(64)
    expect(recipe.accessoryIds!.length).toBeLessThanOrEqual(8)
  })

  it('drops empty and non-string accessories', () => {
    const recipe = parseAvatarRecipe({ baseModel: 'neutral-a', accessoryIds: ['badge', '', '  ', 7, null] })
    expect(recipe.accessoryIds).toEqual(['badge'])
  })

  it('stamps the current schema version whatever it was given', () => {
    expect(parseAvatarRecipe({ schemaVersion: 99, baseModel: 'male-a' }).schemaVersion).toBe(1)
  })
})

describe('avatarRecipeForCharacter', () => {
  it('uses the same built-in portrait index as the 2D identity seed', () => {
    const violet = avatarRecipeForCharacter({ employeeId: 'employee-a', fallbackAvatarIndex: 0 })
    const navy = avatarRecipeForCharacter({ employeeId: 'employee-b', fallbackAvatarIndex: 1 })

    expect(violet).toMatchObject({ hair: 'long-layered', hairColor: '#7c3aed', outfitColor: '#4338ca' })
    expect(navy).toMatchObject({ hair: 'side-part', hairColor: '#1e293b', outfitColor: '#1e3a8a' })
    expect(violet.hairColor).not.toBe(navy.hairColor)
  })

  it('uses gender only for the shared body and never derives appearance from the name', () => {
    const first = avatarRecipeForCharacter({ employeeId: 'stable-id', gender: 'female', fallbackAvatarIndex: 0 })
    const renamed = avatarRecipeForCharacter({ employeeId: 'stable-id', gender: 'female', fallbackAvatarIndex: 0 })
    expect(first.baseModel).toBe('female-a')
    expect(renamed).toEqual(first)
  })

  it('maps work roles to reusable outfit families without erasing the identity palette', () => {
    const analyst = avatarRecipeForCharacter({ employeeId: 'analyst', role: '数据分析师', fallbackAvatarIndex: 0 })
    const engineer = avatarRecipeForCharacter({ employeeId: 'engineer', role: '开发工程师', fallbackAvatarIndex: 0 })
    expect(analyst.outfit).toBe('analyst')
    expect(engineer.outfit).toBe('engineer')
    expect(analyst.outfitColor).toBe(engineer.outfitColor)
  })

  it('lets a stored profile recipe override the built-in seed', () => {
    const recipe = avatarRecipeForCharacter({
      employeeId: 'employee-a',
      gender: 'female',
      fallbackAvatarIndex: 0,
      appearance: {
        avatarRecipe: {
          baseModel: 'female-a',
          build: 'slender',
          hair: 'ponytail',
          hairColor: '#112233',
          outfitColor: '#445566',
          accentColor: '#778899',
          accessoryIds: ['badge'],
        },
      },
    })
    expect(recipe).toMatchObject({
      baseModel: 'female-a', build: 'slender', hair: 'ponytail', hairColor: '#112233',
      outfitColor: '#445566', accentColor: '#778899', accessoryIds: ['badge'],
    })
  })

  it('is deterministic even when an old profile has no avatar index', () => {
    expect(avatarRecipeForCharacter({ employeeId: 'employee-stable' }))
      .toEqual(avatarRecipeForCharacter({ employeeId: 'employee-stable' }))
  })
})

describe('avatarBaseKey', () => {
  it('shares a download between characters that differ only in trim', () => {
    const left = parseAvatarRecipe({ baseModel: 'neutral-a', hair: 'short', outfitColor: '#111111' })
    const right = parseAvatarRecipe({ baseModel: 'neutral-a', hair: 'long', outfitColor: '#222222' })
    expect(avatarBaseKey(left)).toBe(avatarBaseKey(right))
  })

  it('keeps different bodies apart', () => {
    expect(avatarBaseKey(parseAvatarRecipe({ baseModel: 'male-a' })))
      .not.toBe(avatarBaseKey(parseAvatarRecipe({ baseModel: 'robot-a' })))
  })
})

describe('sameAvatarRecipe', () => {
  it('is true for recipes that would build the same character', () => {
    const recipe = { baseModel: 'female-a', hair: 'bob', accessoryIds: ['glasses'] }
    expect(sameAvatarRecipe(parseAvatarRecipe(recipe), parseAvatarRecipe(recipe))).toBe(true)
  })

  it('notices a changed accessory', () => {
    expect(sameAvatarRecipe(
      parseAvatarRecipe({ baseModel: 'female-a', accessoryIds: ['glasses'] }),
      parseAvatarRecipe({ baseModel: 'female-a', accessoryIds: ['badge'] }),
    )).toBe(false)
  })

  it('notices changed colour or body trim', () => {
    expect(sameAvatarRecipe(
      parseAvatarRecipe({ baseModel: 'female-a', build: 'slender', outfitColor: '#111111' }),
      parseAvatarRecipe({ baseModel: 'female-a', build: 'sturdy', outfitColor: '#222222' }),
    )).toBe(false)
  })
})
