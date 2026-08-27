import { describe, expect, it } from 'vitest'

import { ALL_WORKSHOP_CATALOGS } from '../src/i18n/workshop-messages.js'

describe('creative workshop locale catalogs', () => {
  it('keeps all twelve catalogs complete and non-empty', () => {
    const entries = Object.entries(ALL_WORKSHOP_CATALOGS)
    expect(entries).toHaveLength(12)
    const referenceKeys = Object.keys(ALL_WORKSHOP_CATALOGS['zh-CN']).sort()
    expect(referenceKeys.length).toBeGreaterThan(80)

    for (const [locale, catalog] of entries) {
      expect(Object.keys(catalog).sort(), locale).toEqual(referenceKeys)
      expect(Object.values(catalog).every((message) => message.trim().length > 0), locale).toBe(true)
    }
  })
})
