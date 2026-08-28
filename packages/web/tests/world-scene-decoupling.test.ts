import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const worldSourceRoot = join(process.cwd(), 'packages', 'web', 'src', 'features', 'world')

describe('World Scene ownership guard', () => {
  it('does not let the World Runtime client observe or resolve from the active Skin', () => {
    const source = readFileSync(join(worldSourceRoot, 'world-client-store.ts'), 'utf8')
    expect(source).not.toContain('dataset.skin')
    expect(source).not.toContain('MutationObserver')
    expect(source).not.toContain('readWorldTheme')
    expect(source).not.toContain('resolveThemeManifest')
    expect(source).toContain('/theme-manifest')
  })

  it('keeps Skin choice and World Scene choice in separate UI controls', () => {
    const skin = readFileSync(join(process.cwd(), 'packages', 'web', 'src', 'components', 'WorldThemeSwitcher.tsx'), 'utf8')
    const world = readFileSync(join(worldSourceRoot, 'WorldRuntimeDock.tsx'), 'utf8')
    expect(skin).toContain('界面 / 会话皮肤')
    expect(skin).toContain('右侧世界场景保持独立')
    expect(world).toContain('aria-label="世界场景"')
    expect(world).toContain('WorldSceneDialog')
  })

  it('renders the World dock as a full spatial scene instead of an actor-only shared Skin overlay', () => {
    const world = readFileSync(join(worldSourceRoot, 'WorldRuntimeDock.tsx'), 'utf8')
    expect(world).not.toContain('world-runtime-dock--shared-scene')
    expect(world).not.toMatch(/\bsharedScene\b/)
  })
})
