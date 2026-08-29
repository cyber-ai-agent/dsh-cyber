import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const worldSourceRoot = join(process.cwd(), 'packages', 'web', 'src', 'features', 'world')
const componentSourceRoot = join(process.cwd(), 'packages', 'web', 'src', 'components')

describe('World Scene ownership guard', () => {
  it('does not let the World Runtime client observe or resolve from the active Skin', () => {
    const source = readFileSync(join(worldSourceRoot, 'world-client-store.ts'), 'utf8')
    const executableSource = stripComments(source)
    expect(executableSource).not.toContain('dataset.skin')
    expect(executableSource).not.toContain('MutationObserver')
    expect(executableSource).not.toContain('readWorldTheme')
    expect(executableSource).not.toContain('resolveThemeManifest')
    expect(executableSource).toContain('/theme-manifest')
  })

  it('keeps Skin choice and World Scene choice in separate UI controls', () => {
    const skin = readFileSync(join(componentSourceRoot, 'WorldThemeSwitcher.tsx'), 'utf8')
    const world = readFileSync(join(worldSourceRoot, 'WorldRuntimeDock.tsx'), 'utf8')
    expect(skin).toContain('界面 / 会话皮肤')
    expect(skin).toContain('右侧世界场景保持独立')
    expect(world).toContain('aria-label="世界场景"')
    expect(world).toContain('WorldSceneDialog')
  })

  it('renders the World dock as a full spatial scene instead of an actor-only shared Skin overlay', () => {
    const world = readFileSync(join(worldSourceRoot, 'WorldRuntimeDock.tsx'), 'utf8')
    const canvas = readFileSync(join(worldSourceRoot, 'WorldCanvas.tsx'), 'utf8')
    expect(world).not.toContain('world-runtime-dock--shared-scene')
    expect(world).not.toMatch(/\bsharedScene\b/)
    expect(canvas).not.toMatch(/\bsharedScene\b/)
    expect(canvas).not.toContain('world-canvas-host--shared-scene')
  })

  it('keeps durable scene saves distinct from live renderer refresh failures', () => {
    const dialog = readFileSync(join(worldSourceRoot, 'WorldSceneDialog.tsx'), 'utf8')
    expect(dialog).toContain('markApplied(item)')
    expect(dialog).toContain('场景已经保存，但实时画面刷新失败')
    expect(dialog).toContain('disabled={applyingId !== undefined || selected}')
    expect(dialog.indexOf('markApplied(item)')).toBeLessThan(dialog.indexOf('await onApplied()'))
  })

  it('does not remount or restyle a World when only the conversation Skin changes', () => {
    const switcher = stripComments(readFileSync(join(componentSourceRoot, 'WorldThemeSwitcher.tsx'), 'utf8'))
    const fallbackWorld = stripComments(readFileSync(join(componentSourceRoot, 'WorldView.tsx'), 'utf8'))
    expect(switcher).not.toMatch(/\bonThemeChange\s*\?\./)
    expect(fallbackWorld).not.toContain('dataset.skin')
    expect(fallbackWorld).not.toContain('currentSkin')
    expect(fallbackWorld).not.toMatch(/sceneImage\s*\?\?/) 
  })
})

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
