import { describe, expect, it } from 'vitest'

import type { SkillCatalogEntry } from '@dsh-cyber/contracts/skill-runtime'

describe('Skill Catalog contract', () => {
  it('keeps source, scope and availability explicit at the response boundary', () => {
    const entry = {
      id: 'coding',
      displayName: '软件实现',
      summary: '安全的软件实现工作方法。',
      adapterId: 'builtin.recipe',
      risks: [],
      supportsScheduling: false,
      persistentApproval: 'forbidden',
      kind: 'recipe',
      recommendedByDefault: true,
      source: 'builtin',
      scope: 'builtin',
      globalKnown: true,
      worldAvailable: true,
      availability: 'available',
    } satisfies SkillCatalogEntry

    expect(entry).toMatchObject({ source: 'builtin', scope: 'builtin', availability: 'available' })
  })
})
