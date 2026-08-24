import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { CyberMarketPackage, World } from '@dsh-cyber/contracts'

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
    expect(html).toMatch(/<button type="button">立即使用<\/button>/)
  })

  it('gives installed role templates a recruitment action instead of a dead installed state', () => {
    const html = marketHtml(roleItem(), 'talent')
    expect(html).toContain('招募到世界')
    expect(html).not.toContain('角色模板已安装</button>')
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

function marketHtml(item: CyberMarketPackage, initialMarket: 'plugin' | 'talent' = 'plugin'): string {
  return renderToStaticMarkup(createElement(PackageMarketDialog, {
    initialMarket,
    world,
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

function pluginItem(): CyberMarketPackage {
  return {
    market: 'plugin',
    sourceDirectory: 'marketplace/plugins/official-research-brief',
    verified: true,
    installedVersion: '1.0.0',
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
    activation: {
      kind: 'employee-blueprint',
      blueprintId: 'official-archivist',
      blueprintVersion: 1,
      worldTemplateId: 'cyber-company',
    },
    manifest: manifest('official-archivist', 'employee-blueprint', '档案管理员', ['employee:blueprint']),
  }
}

function manifest(id: string, kind: 'plugin' | 'employee-blueprint', displayName: string, capabilities: string[]) {
  return {
    schemaVersion: 1 as const,
    id,
    version: '1.0.0',
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
