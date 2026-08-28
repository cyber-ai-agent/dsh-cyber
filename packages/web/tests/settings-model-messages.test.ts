import { describe, expect, it } from 'vitest'

import { ALL_SETTINGS_MODEL_CATALOGS } from '../src/i18n/settings-model-messages.js'

describe('settings model locale catalogs', () => {
  it('keeps every model settings message complete across all supported locales', () => {
    const entries = Object.entries(ALL_SETTINGS_MODEL_CATALOGS)
    expect(entries).toHaveLength(12)
    const referenceKeys = Object.keys(ALL_SETTINGS_MODEL_CATALOGS['zh-CN']).sort()
    expect(referenceKeys.length).toBeGreaterThan(60)
    for (const [locale, catalog] of entries) {
      expect(Object.keys(catalog).sort(), locale).toEqual(referenceKeys)
      expect(Object.values(catalog).every((message) => message.trim().length > 0), locale).toBe(true)
    }
  })
})
