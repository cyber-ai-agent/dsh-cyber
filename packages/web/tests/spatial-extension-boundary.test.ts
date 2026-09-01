import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const spatialSourceRoot = join(process.cwd(), 'packages', 'web', 'src', 'features', 'world', 'extensions', 'spatial-3d')
const budgetScript = join(process.cwd(), 'scripts', 'check-build-budget.mjs')

describe('optional 3D extension boundary', () => {
  it('reaches the 3D renderer registry only through a dynamic import', () => {
    const canvas = readFileSync(join(spatialSourceRoot, 'SpatialWorldCanvas.tsx'), 'utf8')

    // A static import would bundle the lazy-three shell into the dialog chunk,
    // so a device that can never draw 3D downloads it just by opening the dialog.
    expect(canvas).not.toMatch(/^import\s+(?!type\b)[^\n]*from '\.\/spatial-renderer-registry\.js'/mu)
    expect(canvas).toContain("import('./spatial-renderer-registry.js')")
  })

  it('gives the extension chunk its own size budget', () => {
    const budget = readFileSync(budgetScript, 'utf8')

    expect(budget).toContain('^SpatialWorldExtensionDialog-.*\\.js$')
  })
})
