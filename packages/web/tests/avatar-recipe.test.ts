import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AVATAR_RECIPE,
  avatarBaseKey,
  parseAvatarRecipe,
  sameAvatarRecipe,
} from '../src/features/world/avatar/avatar-recipe.js'

describe('parseAvatarRecipe', () => {
  it('reads a complete recipe', () => {
    expect(parseAvatarRecipe({
      schemaVersion: 1,
      baseModel: 'female-a',
      hair: 'bob',
      hairColor: '#2A1B10',
      skinTone: '#e8c39e',
      outfit: 'blazer',
      outfitColor: '#1f2a37',
      accessoryIds: ['glasses', 'badge'],
    })).toEqual({
      schemaVersion: 1,
      baseModel: 'female-a',
      hair: 'bob',
      hairColor: '#2a1b10',
      skinTone: '#e8c39e',
      outfit: 'blazer',
      outfitColor: '#1f2a37',
      accessoryIds: ['glasses', 'badge'],
    })
  })

  it('gives a character an appearance rather than an error', () => {
    // A recipe arrives from a stored revision or an installed package. A
    // corrupt one should leave the character in the world looking like
    // somebody, not throw them out of it.
    expect(parseAvatarRecipe(undefined)).toEqual(DEFAULT_AVATAR_RECIPE)
    expect(parseAvatarRecipe('nonsense')).toEqual(DEFAULT_AVATAR_RECIPE)
    expect(parseAvatarRecipe([])).toEqual(DEFAULT_AVATAR_RECIPE)
    expect(parseAvatarRecipe({ baseModel: 'dragon' })).toEqual(DEFAULT_AVATAR_RECIPE)
  })

  it('refuses anything that is not a colour where a colour goes', () => {
    // These reach a material. A package is somebody else's data, and a string
    // that is not a colour is either a mistake or an attempt to put something
    // else where a colour is expected.
    const recipe = parseAvatarRecipe({
      baseModel: 'neutral-a',
      hairColor: 'url(http://example.com/x.png)',
      skinTone: 'red',
      outfitColor: '#12345',
    })
    expect(recipe.hairColor).toBeUndefined()
    expect(recipe.skinTone).toBeUndefined()
    expect(recipe.outfitColor).toBeUndefined()
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

describe('avatarBaseKey', () => {
  it('shares a download between characters that differ only in trim', () => {
    // The base model is the multi-megabyte part; hair and colour are applied
    // on top. Two characters built from the same body should fetch it once.
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

  it('notices a changed colour', () => {
    expect(sameAvatarRecipe(
      parseAvatarRecipe({ baseModel: 'female-a', outfitColor: '#111111' }),
      parseAvatarRecipe({ baseModel: 'female-a', outfitColor: '#222222' }),
    )).toBe(false)
  })
})
