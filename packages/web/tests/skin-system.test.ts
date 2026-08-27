import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CyberMarketPackage, World } from '@dsh-cyber/contracts'

import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { SettingsDialog } from '../src/components/SettingsDialog.js'
import { WorldThemeSwitcher } from '../src/components/WorldThemeSwitcher.js'
import { BUILTIN_THEMES, applyWorldTheme, resolveThemeManifest, themeRegistry } from '../src/features/world/world-themes.js'
import { setUiLocale } from '../src/i18n/runtime.js'

const world: World = {
  id: 'world-1',
  workspaceId: 'workspace-1',
  name: '赛博公司',
  templateId: 'cyber-company',
  status: 'active',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('modern skin system and marketplace category', () => {
  beforeEach(() => setUiLocale('zh-CN'))

  it('renders skin category tab in package market dialog', () => {
    const items = skinItems()
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      initialMarket: 'skin',
      world,
      worlds: [world],
      items,
      installed: [],
      transactions: [],
      loading: false,
      installing: false,
      currentSkinId: 'cyber-graphite',
      onApplySkin: vi.fn(),
      onClose: vi.fn(),
      onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(async () => ({ summary: '', dangerousOperations: [], files: [] })),
      onInstallMarketplace: vi.fn(async () => undefined),
      onUninstall: vi.fn(async () => undefined),
      onOpenSettings: vi.fn(),
      onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined),
      onUsePlugin: vi.fn(),
      onPreview: vi.fn(async () => ({ summary: '', dangerousOperations: [], files: [] })),
      onInstall: vi.fn(async () => undefined),
    }))

    expect(html).toContain('世界</button>')
    expect(html).toContain('角色</button>')
    expect(html).toContain('插件</button>')
    expect(html).toContain('皮肤</button>')
    expect(html).toContain('默认皮肤')
    expect(html).toContain('深海女仆工坊')
    expect(html).toContain('虎鲸链路')
    expect(html).toContain('默认皮肤 · 始终可用')
    expect(html).toContain('查看并安装')
  })

  it('keeps skin selection in the market instead of duplicating it in SettingsDialog', () => {
    const html = renderToStaticMarkup(createElement(SettingsDialog, {
      initialSection: 'appearance',
      preferences: {
        locale: 'zh-CN',
        colorScheme: 'dark',
        skinId: 'maid-atelier',
        customBackground: '',
        backgroundFit: 'cover',
        backgroundPosition: 'center',
        backgroundOpacity: 0.1,
        panelScale: 1,
        developerMode: false,
        messageHistoryPageSize: 50,
      },
      models: [],
      assignments: [],
      workspace: {
        id: 'workspace-1',
        name: '工作区',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
      worlds: [world],
      employees: [],
      saving: false,
      onClose: vi.fn(),
      onSavePreferences: vi.fn(async () => undefined),
      onUploadBackground: vi.fn(async () => 'asset-1'),
      onSaveModel: vi.fn(async () => undefined),
      onDiscoverModels: vi.fn(async () => []),
      onDeleteModel: vi.fn(async () => undefined),
      onAssignModel: vi.fn(async () => undefined),
      onSystemAction: vi.fn(async () => ({ ok: true })),
    }))

    expect(html).toContain('皮肤请前往扩展市场选择')
    expect(html).not.toContain('深海女仆工坊')
    expect(html).not.toContain('虎鲸链路')
    expect(html).not.toContain('赛博原厂')
    expect(html).not.toContain('月影酒馆')
    expect(html).not.toContain('欧式图书殿堂')
    expect(html).not.toContain('世界专属主题模式已生效')
    expect(html).not.toContain('世界专属主题')
  })

  it('renders visual skin thumbnails instead of palette-only cards', () => {
    const items = skinItems()
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      initialMarket: 'skin',
      world,
      worlds: [world],
      items,
      installed: [],
      transactions: [],
      loading: false,
      installing: false,
      currentSkinId: 'maid-atelier',
      onApplySkin: vi.fn(),
      onClose: vi.fn(),
      onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(async () => ({ summary: '', dangerousOperations: [], files: [] })),
      onInstallMarketplace: vi.fn(async () => undefined),
      onUninstall: vi.fn(async () => undefined),
      onOpenSettings: vi.fn(),
      onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined),
      onUsePlugin: vi.fn(),
      onPreview: vi.fn(async () => ({ summary: '', dangerousOperations: [], files: [] })),
      onInstall: vi.fn(async () => undefined),
    }))

    expect(html).not.toContain('market-skin-palette')
    expect((html.match(/class="market-skin-preview"/g) ?? []).length).toBe(items.length)
    expect(html).toContain('/assets/skins/maid-palace-night.webp')
    expect(html).toContain('/assets/skins/orca-bridge-night.png')
  })

  it('labels the world skin switcher consistently', () => {
    const html = renderToStaticMarkup(createElement(WorldThemeSwitcher, { activeWorld: world, installedSkinIds: ['maid-atelier'] }))
    expect(html).toContain('皮肤:')
    expect(html).toContain('默认皮肤')
    const available = themeRegistry.listAvailable(['maid-atelier']).map((theme) => theme.id)
    expect(available).toEqual(expect.arrayContaining(['default', 'maid-atelier']))
    expect(available).not.toContain('orca-link')
  })

  it('keeps every runtime theme on one canonical scene source', () => {
    for (const theme of BUILTIN_THEMES) {
      const sceneImage = theme.tokens.worldMapImage ?? theme.tokens.backdropImage
      expect(sceneImage, `${theme.id} must declare a scene image`).toBeDefined()
      expect(theme.tokens.backdropImage).toBe(sceneImage)
      if (theme.runtimeManifest !== undefined) {
        expect(theme.runtimeManifest.assets.find((asset) => asset.kind === 'image')?.src).toBe(sceneImage)
      }
      applyWorldTheme(theme.id)
      expect(document.documentElement.style.getPropertyValue('--theme-backdrop-image')).toContain(sceneImage!)
    }
  })

  it('compiles an uploaded custom panorama into the same runtime scene', () => {
    const customId = 'custom-uploaded-scene-test'
    themeRegistry.saveCustomTheme({
      id: customId,
      displayName: '上传场景',
      description: '测试',
      author: '测试',
      source: 'custom',
      tokens: {
        ...BUILTIN_THEMES[0]!.tokens,
        backdropImage: '/api/assets/scene-asset',
        worldMapImage: '/api/assets/scene-asset',
      },
    })
    try {
      const manifest = resolveThemeManifest(world, customId)
      expect(manifest.assets[0]?.src).toBe('/api/assets/scene-asset')
      expect(manifest.scenes[0]?.layers[0]?.assetId).toBe(`${customId}-shared-scene`)
    } finally {
      themeRegistry.deleteCustomTheme(customId)
    }
  })
})

function skinItems(): CyberMarketPackage[] {
  return [
    ['default-skin', '默认皮肤'],
    ['maid-atelier', '深海女仆工坊'],
    ['cyber-company', '赛博原厂'],
    ['orca-link', '虎鲸链路'],
    ['moonlit-tavern', '月影酒馆'],
  ].map(([id, displayName]) => ({
    market: 'skin',
    manifest: {
      schemaVersion: 1,
      id,
      version: '1.0.0',
      kind: 'skin',
      displayName,
      summary: `${displayName}完整场景皮肤`,
      license: 'PolyForm-Noncommercial-1.0.0',
      publisher: 'DSH Cyber',
      capabilities: ['ui:skin'],
      dataEgress: [],
      files: [{ path: 'skin.json', sha256: 'a'.repeat(64) }],
      entrypoints: [{ id, kind: 'skin', path: 'skin.json' }],
    },
    sourceDirectory: `marketplace/skins/${id}`,
    verified: true,
    ...(id === 'default-skin' ? {} : { activation: { kind: 'skin' as const, skinId: id, skinVersion: '1.0.0', themeId: id } }),
  }))
}
