import { describe, expect, it } from 'vitest'

import {
  ALL_APPEARANCE_CATALOGS,
  BUILTIN_THEME_IDS,
  getLocalizedThemeText,
  zhCNAppearance,
} from '../src/i18n/appearance-messages.js'

describe('appearance locale catalogs', () => {
  it('keeps every appearance catalog complete and non-empty', () => {
    const referenceKeys = Object.keys(zhCNAppearance).sort()
    for (const [locale, catalog] of Object.entries(ALL_APPEARANCE_CATALOGS)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(referenceKeys)
      expect(Object.values(catalog).every((message) => message.trim().length > 0), locale).toBe(true)
    }
  })

  it('provides localized copy for every built-in theme id', () => {
    const theme = { id: 'default', displayName: '默认皮肤', description: '默认描述', source: 'builtin' as const }
    for (const locale of Object.keys(ALL_APPEARANCE_CATALOGS) as Array<keyof typeof ALL_APPEARANCE_CATALOGS>) {
      const text = getLocalizedThemeText(theme, locale)
      expect(text.displayName.trim(), locale).not.toBe('')
      expect(text.description.trim(), locale).not.toBe('')
    }
    expect(BUILTIN_THEME_IDS).toContain('black-orca')
  })

  it('keeps custom and extension metadata verbatim for content labeling', () => {
    const custom = { id: 'user-theme', displayName: '用户自定义名', description: '用户自己的描述', source: 'custom' as const }
    const extension = { id: 'package-theme', displayName: 'Package authored name', description: 'Package authored description', source: 'package' as const }
    expect(getLocalizedThemeText(custom, 'ja-JP')).toEqual({ displayName: custom.displayName, description: custom.description })
    expect(getLocalizedThemeText(extension, 'ar-SA')).toEqual({ displayName: extension.displayName, description: extension.description })
  })
})
