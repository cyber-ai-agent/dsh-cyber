import { describe, expect, it } from 'vitest'

import type { CreativeWorkshopDraftV1 } from '../src/creative-workshop-draft.js'

describe('CreativeWorkshopDraftV1', () => {
  it('keeps AI output suggestion-only and gives every character a draft identity', () => {
    const draft: CreativeWorkshopDraftV1 = {
      schemaVersion: 1,
      world: { name: '夜航工作室', modelPolicy: { mode: 'inherit' } },
      characters: [
        { tempId: 'draft-1', name: '林夕', requestedSkills: ['product-planning'] },
        { tempId: 'draft-2', name: '阿澈', modelPolicy: { mode: 'recommend', requiredCapabilities: ['text', 'tools'], reason: '负责开发' } },
      ],
    }
    expect(new Set(draft.characters.map((character) => character.tempId)).size).toBe(2)
    expect(JSON.stringify(draft)).not.toContain('skillGrants')
    expect(JSON.stringify(draft)).not.toContain('approvedPermission')
  })
})
