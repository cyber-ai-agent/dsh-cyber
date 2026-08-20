import { describe, expect, it } from 'vitest'

import { cyberCompanyTheme } from '@dsh-cyber/world-runtime'

import { validateWorldThemePackageAssets } from '../src/world-theme-package.js'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('installed world theme package assets', () => {
  it('accepts declared package-owned image and spritesheet files', async () => {
    const theme = structuredClone(cyberCompanyTheme)
    theme.assets[0]!.src = 'assets/scene.png'
    theme.assets[1]!.src = 'assets/roster.png'
    await expect(validateWorldThemePackageAssets(
      theme,
      new Set(['assets/scene.png', 'assets/roster.png']),
      async () => png,
    )).resolves.toBeUndefined()
  })

  it('rejects app assets, mismatched signatures, and non-PNG spritesheets', async () => {
    const appAsset = structuredClone(cyberCompanyTheme)
    appAsset.assets[0]!.src = '/assets/scene.png'
    await expect(validateWorldThemePackageAssets(appAsset, new Set(['/assets/scene.png']), async () => png))
      .rejects.toThrow('package assets/ path')

    const traversalAsset = structuredClone(cyberCompanyTheme)
    traversalAsset.assets[0]!.src = 'assets/../secret.png'
    await expect(validateWorldThemePackageAssets(
      traversalAsset,
      new Set(['assets/../secret.png']),
      async () => png,
    )).rejects.toThrow('package assets/ path')

    const invalid = structuredClone(cyberCompanyTheme)
    invalid.assets[0]!.src = 'assets/scene.png'
    invalid.assets[1]!.src = 'assets/roster.jpg'
    await expect(validateWorldThemePackageAssets(
      invalid,
      new Set(['assets/scene.png', 'assets/roster.jpg']),
      async (path) => path.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff]) : Buffer.from('not-png'),
    )).rejects.toThrow(/signature|spritesheet/)
  })

  it('rejects image resources over the package size limit', async () => {
    const theme = structuredClone(cyberCompanyTheme)
    theme.assets[0]!.src = 'assets/scene.png'
    theme.assets[1]!.src = 'assets/roster.png'
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1)
    png.copy(oversized)
    await expect(validateWorldThemePackageAssets(
      theme,
      new Set(['assets/scene.png', 'assets/roster.png']),
      async (path) => path === 'assets/scene.png' ? oversized : png,
    )).rejects.toThrow('exceeds its size limit')
  })
})
