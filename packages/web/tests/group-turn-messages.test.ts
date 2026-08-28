import { describe, expect, it } from 'vitest'

import { GROUP_TURN_MESSAGES } from '../src/i18n/group-turn-messages.js'

describe('group turn locale copy', () => {
  it('covers every supported interface locale', () => {
    expect(Object.keys(GROUP_TURN_MESSAGES)).toHaveLength(12)
    expect(Object.values(GROUP_TURN_MESSAGES).every((message) => message.includes('{count}'))).toBe(true)
  })
})
