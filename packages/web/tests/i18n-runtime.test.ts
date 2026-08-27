import { beforeEach, describe, expect, it } from 'vitest'

import { ALL_MESSAGE_CATALOGS, enUS, zhCN } from '../src/i18n/messages.js'
import { getUiLocale, resolveUiLocale, setUiLocale, translate, UI_LOCALES } from '../src/i18n/runtime.js'

describe('UI locale runtime', () => {
  beforeEach(() => setUiLocale('zh-CN'))

  it('supports the common locale catalog and resolves browser language variants', () => {
    expect(UI_LOCALES.map((item) => item.id)).toEqual([
      'zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'es-ES',
      'fr-FR', 'de-DE', 'pt-BR', 'ru-RU', 'ar-SA', 'hi-IN',
    ])
    expect(resolveUiLocale('en-GB')).toBe('en-US')
    expect(resolveUiLocale('zh-Hant')).toBe('zh-TW')
    expect(resolveUiLocale('zh-Hans-SG')).toBe('zh-CN')
    expect(resolveUiLocale('unknown')).toBe('zh-CN')
  })

  it('keeps message keys complete in every supported language', () => {
    const referenceKeys = Object.keys(zhCN).sort()
    expect(Object.keys(enUS).sort()).toEqual(referenceKeys)
    for (const [locale, catalog] of Object.entries(ALL_MESSAGE_CATALOGS)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(referenceKeys)
      expect(Object.values(catalog).every((message) => message.trim().length > 0), locale).toBe(true)
    }
    expect(translate('status.completed', 'fallback')).toBe('已完成')
    setUiLocale('en-US')
    expect(translate('status.completed', 'fallback')).toBe('Completed')
  })

  it('updates document language and writing direction', () => {
    setUiLocale('ar-SA')
    expect(getUiLocale()).toBe('ar-SA')
    expect(document.documentElement.lang).toBe('ar-SA')
    expect(document.documentElement.dir).toBe('rtl')
  })
})
