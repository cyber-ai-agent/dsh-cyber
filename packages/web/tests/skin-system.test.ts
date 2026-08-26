import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'

import { MARKET_SKIN_PACKAGES, PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { SettingsDialog } from '../src/components/SettingsDialog.js'

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
    expect(html).toContain('赛博霓虹 2.0 (Cyberpunk Horizon)')
    expect(html).toContain('极简黑曜 (Linear Obsidian Pro)')
    expect(html).toContain('极光星云 (Nebula Velvet)')
    expect(html).toContain('暖阳白昼 (Claude Warm Daylight)')
    expect(html).toContain('战术机甲 (Tactical Armor Mech)')
    expect(html).toContain('深海冷蓝 (Midnight Ocean)')
    expect(html).toContain('✓ 正在使用')
    expect(html).toContain('立即换肤')
  })

  it('provides rich skin selector cards in SettingsDialog with all 6 modern themes', () => {
    const html = renderToStaticMarkup(createElement(SettingsDialog, {
      initialSection: 'appearance',
      preferences: {
        colorScheme: 'dark',
        skinId: 'linear-obsidian',
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

    expect(html).toContain('赛博霓虹 2.0')
    expect(html).toContain('极简黑曜')
    expect(html).toContain('极光星云')
    expect(html).toContain('暖阳白昼')
    expect(html).toContain('战术机甲')
    expect(html).toContain('深海冷蓝')
    expect(html).toContain('Linear 旗舰质感')
  })

  it('defines 6 modern skin package descriptors in MARKET_SKIN_PACKAGES', () => {
    expect(MARKET_SKIN_PACKAGES.length).toBe(6)
    const ids = MARKET_SKIN_PACKAGES.map((s) => s.id)
    expect(ids).toEqual([
      'cyber-graphite',
      'linear-obsidian',
      'nebula-velvet',
      'paper-daylight',
      'mecha-tactical',
      'midnight-violet',
    ])
  })
})
