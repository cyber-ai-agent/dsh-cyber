import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { MARKET_SKIN_PACKAGES, PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { SettingsDialog } from '../src/components/SettingsDialog.js'
import { WorldThemeSwitcher } from '../src/components/WorldThemeSwitcher.js'
import { BUILTIN_THEMES, applyWorldTheme } from '../src/features/world/world-themes.js'

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
  it('renders skin category tab in package market dialog', () => {
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      initialMarket: 'skin',
      world,
      worlds: [world],
      items: [],
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
    expect(html).toContain('深海女仆工坊 (Maid Atelier · 鲸鱼娘)')
    expect(html).toContain('虎鲸链路 (Orca Link · 虎鲸娘)')
    expect(html).toContain('绝区零 · 星见雅 (ZZZ Miyabi)')
    expect(html).toContain('绝区零 · 艾莲 (ZZZ Ellen)')
    expect(html).toContain('初恋时刻 (First Love)')
    expect(html).toContain('蛛网都市 (Spider Verse)')
    expect(html).toContain('宝可梦黄昏 (Pokemon Sunset)')
    expect(html).toContain('木叶忍界 (Naruto Konoha)')
    expect(html).toContain('鬼灭藤夜 (Demon Slayer Night)')
    expect(html).toContain('赛博霓虹 2.0 (Cyberpunk Horizon)')
    expect(html).toContain('极简黑曜 (Linear Obsidian Pro)')
    expect(html).toContain('暖阳白昼 (Claude Warm Daylight)')
    expect(html).toContain('✓ 正在使用')
    expect(html).toContain('应用到当前世界')
  })

  it('keeps skin selection in the market instead of duplicating it in SettingsDialog', () => {
    const html = renderToStaticMarkup(createElement(SettingsDialog, {
      initialSection: 'appearance',
      preferences: {
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

  it('defines 12 modern skin package descriptors in MARKET_SKIN_PACKAGES', () => {
    expect(MARKET_SKIN_PACKAGES.length).toBe(12)
    const ids = MARKET_SKIN_PACKAGES.map((s) => s.id)
    expect(ids).toEqual([
      'maid-atelier',
      'orca-link',
      'zzz-miyabi',
      'zzz-ellen',
      'first-love',
      'spider-verse',
      'pokemon-sunset',
      'naruto-konoha',
      'demon-slayer-night',
      'cyber-graphite',
      'linear-obsidian',
      'paper-daylight',
    ])
  })

  it('renders visual skin thumbnails instead of palette-only cards', () => {
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      initialMarket: 'skin',
      world,
      worlds: [world],
      items: [],
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
    expect((html.match(/class="market-skin-preview"/g) ?? []).length).toBe(MARKET_SKIN_PACKAGES.length)
    expect(html).toContain('/assets/skins/maid-palace-night.webp')
    expect(html).toContain('/assets/skins/orca-bridge-night.png')
  })

  it('labels the world skin switcher consistently', () => {
    const html = renderToStaticMarkup(createElement(WorldThemeSwitcher, { activeWorld: world }))
    expect(html).toContain('皮肤:')
  })

  it('keeps every runtime theme on one canonical scene source', () => {
    for (const theme of BUILTIN_THEMES) {
      const sceneImage = theme.tokens.worldMapImage ?? theme.tokens.backdropImage
      expect(sceneImage, `${theme.id} must declare a scene image`).toBeDefined()
      expect(theme.tokens.backdropImage).toBe(sceneImage)
      expect(theme.runtimeManifest?.assets.find((asset) => asset.kind === 'image')?.src).toBe(sceneImage)
      applyWorldTheme(theme.id)
      expect(document.documentElement.style.getPropertyValue('--theme-backdrop-image')).toContain(sceneImage!)
    }
  })
})
