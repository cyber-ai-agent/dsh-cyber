import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { CyberMarketPackage, World } from '@dsh-cyber/contracts'

import { ChatWorkbench } from '../src/components/ChatWorkbench.js'
import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { RecruitmentDialog } from '../src/components/RecruitmentDialog.js'

const world: World = {
  id: 'world-1',
  workspaceId: 'workspace-1',
  name: '赛博公司',
  templateId: 'cyber-company',
  status: 'active',
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('package market activation flow', () => {
  it('keeps the market order as world, role, plugin and gives installed plugins a real use action', () => {
    const html = marketHtml(pluginItem())
    expect(html.indexOf('世界</button>')).toBeLessThan(html.indexOf('角色</button>'))
    expect(html.indexOf('角色</button>')).toBeLessThan(html.indexOf('插件</button>'))
    expect(html).toContain('已安装 v1.0.0 · 可使用')
    expect(html).toContain('立即使用</button>')
  })

  it('gives installed role templates a recruitment action instead of a dead installed state', () => {
    const html = marketHtml(roleItem(), 'talent')
    expect(html).toContain('招募到世界')
    expect(html).not.toContain('角色模板已安装</button>')
  })

  it('distinguishes a package-library install from activation in the selected world', () => {
    const { worldVersion: _worldVersion, ...item } = pluginItem()
    const html = marketHtml(item)
    expect(html).toContain('包库已有 v1.0.0 · 当前世界未启用')
    expect(html).toContain('启用到当前世界')
    expect(html).not.toContain('立即使用</button>')
  })

  it('distinguishes an included theme from an installed theme', () => {
    const included = marketHtml(themeItem(), 'theme', [{ ...world, templateId: 'personal-world' }])
    expect(included).toContain('is-included')
    expect(included).toContain('已内置 · 当前可用')
    expect(included).toContain('已内置</button>')

    const installed = marketHtml(themeItem('1.0.1'), 'theme', [{ ...world, templateId: 'personal-world' }])
    expect(installed).toContain('is-installed')
    expect(installed).toContain('已安装 v1.0.1 · 可创建')
    expect(installed).toContain('创建新世界')
  })

  it('shows a created state after an installed theme has produced a world', () => {
    const created = marketHtml(themeItem('1.0.1'), 'theme', [{ ...world, templateId: 'cyber-company' }])
    expect(created).toContain('is-created')
    expect(created).toContain('已安装 v1.0.1 · 已创建')
    expect(created).toContain('已创建</button>')
    expect(created).not.toContain('创建新世界')
  })

  it('shows an explicit upgrade state when an older theme is installed', () => {
    const html = marketHtml(themeItem('1.0.0'), 'theme')
    expect(html).toContain('is-upgrade')
    expect(html).toContain('已安装 v1.0.0 · 有新版 v1.0.1')
    expect(html).toContain('升级到 v1.0.1')
  })

  it('exposes installed plugin operations after slash input with a recognizable icon', () => {
    const html = renderToStaticMarkup(createElement(ChatWorkbench, {
      demoMode: true,
      world,
      messages: [],
      employees: [],
      installedPlugins: [{
        packageId: 'official-research-brief',
        packageVersion: '1.0.0',
        displayName: 'Research Brief',
        summary: '整理研究内容',
        trigger: '/research-brief',
        displayTrigger: '/研究简报',
        description: '整理结论和证据。',
        automatic: false,
      }],
      sending: false,
      draft: '/',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment: vi.fn(async () => ({ assetId: 'asset-1', name: 'a.txt', mimeType: 'text/plain', byteLength: 1, url: '/a.txt' })),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
      onOpenPluginMarket: vi.fn(),
    }))
    expect(html).toContain('斜杠操作')
    expect(html).toContain('插件')
    expect(html).toContain('/插件')
    expect(html).not.toContain('composer-plugin-picker__item')
  })

  it('opens recruitment on the market-selected blueprint', () => {
    const html = renderToStaticMarkup(createElement(RecruitmentDialog, {
      blueprints: [
        blueprint('core.other', '其他角色'),
        blueprint('official-archivist', '档案管理员'),
      ],
      initialBlueprintId: 'official-archivist',
      employees: [],
      world,
      loading: false,
      recruiting: false,
      onClose: vi.fn(),
      onRecruit: vi.fn(async () => undefined),
    }))
    expect(html).toContain('<h3>档案管理员</h3>')
    expect(html).toContain('将在当前世界创建独立角色：档案管理员')
  })
})

function marketHtml(item: CyberMarketPackage, initialMarket: 'theme' | 'plugin' | 'talent' = 'plugin', worlds: World[] = [world]): string {
  return renderToStaticMarkup(createElement(PackageMarketDialog, {
    initialMarket,
    world,
    worlds,
    items: [item],
    installed: [],
    transactions: [],
    loading: false,
    installing: false,
    onClose: vi.fn(),
    onSearch: vi.fn(async () => undefined),
    onPreviewMarketplace: vi.fn(),
    onInstallMarketplace: vi.fn(async () => undefined),
    onCreateThemeWorld: vi.fn(async () => undefined),
    onRecruitTalent: vi.fn(async () => undefined),
    onUsePlugin: vi.fn(),
    onPreview: vi.fn(),
    onInstall: vi.fn(async () => undefined),
  }))
}

function themeItem(installedVersion?: string): CyberMarketPackage {
  return {
    market: 'theme',
    sourceDirectory: 'marketplace/themes/official-cyber-nocturne',
    verified: true,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    activation: {
      kind: 'world-theme',
      themeId: 'official-cyber-nocturne',
      themeVersion: '1.0.1',
      templateId: 'cyber-company',
    },
    manifest: manifest('official-cyber-nocturne', 'world-theme', '赛博公司 · 夜班总部', ['world:render'], '1.0.1'),
  }
}

function pluginItem(): CyberMarketPackage {
  return {
    market: 'plugin',
    sourceDirectory: 'marketplace/plugins/official-research-brief',
    verified: true,
    installedVersion: '1.0.0',
    worldVersion: '1.0.0',
    activation: {
      kind: 'prompt-transform',
      automatic: false,
      commands: [{ trigger: '/research-brief', description: '整理研究简报' }],
    },
    manifest: manifest('official-research-brief', 'plugin', '研究简报', ['prompt:transform']),
  }
}

function roleItem(): CyberMarketPackage {
  return {
    market: 'talent',
    sourceDirectory: 'marketplace/talent/official-archivist',
    verified: true,
    installedVersion: '1.0.0',
    worldVersion: '1.0.0',
    activation: {
      kind: 'employee-blueprint',
      blueprintId: 'official-archivist',
      blueprintVersion: 1,
      worldTemplateId: 'cyber-company',
    },
    manifest: manifest('official-archivist', 'employee-blueprint', '档案管理员', ['employee:blueprint']),
  }
}

function manifest(id: string, kind: 'plugin' | 'employee-blueprint' | 'world-theme', displayName: string, capabilities: string[], version = '1.0.0') {
  return {
    schemaVersion: 1 as const,
    id,
    version,
    kind,
    displayName,
    summary: `${displayName}说明`,
    license: 'MIT',
    publisher: 'DSH Cyber',
    capabilities,
    dataEgress: [],
    files: [{ path: 'entrypoint.json', sha256: 'a'.repeat(64) }],
  }
}

function blueprint(id: string, displayName: string) {
  return {
    schemaVersion: 1 as const,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role: `${displayName}角色`,
    summary: `${displayName}说明`,
    persona: '保持角色边界。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-24T00:00:00.000Z',
  }
}
