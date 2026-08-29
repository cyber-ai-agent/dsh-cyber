import { describe, expect, it } from 'vitest'

import {
  BROWSER_READ_SKILL,
  BrowserSkillAdapter,
} from '../src/skills/browser-skill-adapter.js'

describe('BrowserSkillAdapter natural command routing', () => {
  it('accepts compact Chinese action plus URL input without whitespace', () => {
    const adapter = new BrowserSkillAdapter({ store: { getWorld: () => undefined } })
    const proposed = adapter.propose({
      worldId: 'world-browser',
      characterId: 'employee-browser',
      prompt: '请阅读https://example.com/report',
      grantedSkillIds: [BROWSER_READ_SKILL],
      now: new Date('2026-08-29T00:00:00.000Z'),
    })

    expect(proposed).toHaveLength(1)
    expect(proposed[0]).toMatchObject({
      skillId: BROWSER_READ_SKILL,
      action: 'browser.read',
      target: 'https://example.com/report',
      parameters: { url: 'https://example.com/report' },
    })
  })
})
