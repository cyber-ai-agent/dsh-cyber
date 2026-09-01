import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readWorldExtensionEnabled, writeWorldExtensionEnabled } from '../src/features/world/extensions/world-extension-preference.js'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

describe('world extension preferences', () => {
  it('keeps spatial 3D disabled until the user explicitly opts in', () => {
    expect(readWorldExtensionEnabled('spatial-3d')).toBe(false)
    writeWorldExtensionEnabled('spatial-3d', true)
    expect(readWorldExtensionEnabled('spatial-3d')).toBe(true)
    writeWorldExtensionEnabled('spatial-3d', false)
    expect(readWorldExtensionEnabled('spatial-3d')).toBe(false)
  })
})
