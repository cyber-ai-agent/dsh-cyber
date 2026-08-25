import { describe, expect, it, vi } from 'vitest'

import { availableWorldSkillIds } from '../src/services/world-skill-availability.js'

describe('World Skill availability batching', () => {
  it('does not scan the catalog when a character has no granted skills', async () => {
    const availableSkillIds = vi.fn(() => ['unexpected'])
    const result = await availableWorldSkillIds({ isAvailable: () => true, availableSkillIds }, {
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      skillIds: [],
    })
    expect(result).toEqual([])
    expect(availableSkillIds).not.toHaveBeenCalled()
  })

  it('uses one batch query and preserves only requested IDs in caller order', async () => {
    const availableSkillIds = vi.fn(() => ['skill-b', 'unrequested'])
    const isAvailable = vi.fn(() => false)
    const result = await availableWorldSkillIds({ isAvailable, availableSkillIds }, {
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      skillIds: ['skill-a', 'skill-b'],
    })
    expect(result).toEqual(['skill-b'])
    expect(availableSkillIds).toHaveBeenCalledOnce()
    expect(isAvailable).not.toHaveBeenCalled()
  })
})
