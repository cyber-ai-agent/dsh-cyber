import { beforeAll, describe, expect, it } from 'vitest'

import { setUiLocale, translate } from '../src/i18n/runtime.js'

beforeAll(async () => {
  await import('../src/i18n/world-scene-messages.js')
})

describe('World Scene and conversation Skin messages', () => {
  it('keeps the English copy explicit about independent ownership', () => {
    setUiLocale('en-US')
    expect(translate('worldSettings.tabConversationSkin', 'fallback')).toBe('Conversation Skin')
    expect(translate('appearance.theme.conversationMenuDescription', 'fallback', { world: 'Studio' })).toContain('World Scene stays independent')
  })

  it('keeps the Chinese copy explicit about separate World Scene selection', () => {
    setUiLocale('zh-CN')
    expect(translate('worldSettings.skinSceneSeparationHint', 'fallback')).toContain('世界场景属于 World 本身')
  })
})
