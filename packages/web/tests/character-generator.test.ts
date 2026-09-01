import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  AnalysisStep,
  PreviewStep,
  PublishStep,
  SourceStep,
} from '../src/components/character-generator/CharacterGeneratorSteps.js'
import type { CharacterBlueprintDraft, CharacterGeneratorCatalog } from '../src/components/character-generator/model.js'
import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'

const draft: CharacterBlueprintDraft = {
  schemaVersion: 1,
  targetWorldTemplateId: 'personal-world',
  displayName: 'AI 工程师',
  role: '机器学习工程师与 AI 系统架构师',
  summary: '从数据到上线构建可靠的 AI 系统。',
  persona: '只依据当前世界中可验证的工程证据工作。',
  personalityTraits: ['务实', '数据驱动'],
  background: '经历过模型上线故障并坚持复盘。',
  requestedSkillIds: ['coding'],
  requestedCapabilities: ['workspace:read'],
  sourceSummary: '来自 Markdown 角色资料。',
  sourceRefs: ['source:engineering-ai-engineer.md'],
}

const catalog: CharacterGeneratorCatalog = {
  skills: [{ id: 'coding', displayName: '软件实现', summary: '以可验证方式实现软件需求。', recommended: true } as any],
  capabilities: [{ id: 'workspace:read', displayName: '读取当前世界', summary: '只读访问当前世界工作区。' }],
  avatars: [],
}

describe('Character Generator render and accessibility contracts', () => {
  it('renders a visible source/file entry with labeled inputs and an explicit analyze action', () => {
    const html = renderToStaticMarkup(createElement(SourceStep, {
      sourceMode: 'file',
      source: '# AI 工程师',
      sourceFileName: 'engineering-ai-engineer.md',
      analyzing: false,
      onSourceMode: vi.fn(),
      onSource: vi.fn(),
      onFile: vi.fn(),
      onAnalyze: vi.fn(),
    }))
    expect(html).toContain('01')
    expect(html).toContain('role="radio"')
    expect(html).toContain('type="file"')
    expect(html).toContain('engineering-ai-engineer.md')
    expect(html).toContain('角色描述')
    expect(html).toContain('开始分析')
    expect(html).toContain('不可信数据')
  })

  it('renders the four-step review surface with labeled identity, persona, skill and capability controls', () => {
    const sourceHtml = renderToStaticMarkup(createElement(SourceStep, {
      sourceMode: 'paste', source: 'AI 工程师', analyzing: false, onSourceMode: vi.fn(), onSource: vi.fn(), onFile: vi.fn(), onAnalyze: vi.fn(),
    }))
    const analysisHtml = renderToStaticMarkup(createElement(AnalysisStep, {
      source: 'AI 工程师', draft, analyzing: false, onCancel: vi.fn(), onRetry: vi.fn(), onContinue: vi.fn(),
    }))
    const previewHtml = renderToStaticMarkup(createElement(PreviewStep, {
      draft, catalog, avatar: { kind: 'builtin', id: 'official-archivist' }, avatarError: undefined, validationError: undefined,
      onDraftChange: vi.fn(), onAvatarSelect: vi.fn(), onAvatarUpload: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(),
    }))
    const publishHtml = renderToStaticMarkup(createElement(PublishStep, {
      draft, source: 'AI 工程师', avatar: { kind: 'builtin', id: 'official-archivist' }, catalog,
      publishing: false, published: false, onBack: vi.fn(), onPublish: vi.fn(), onViewInstall: vi.fn(),
    }))
    expect(sourceHtml).toContain('01')
    expect(analysisHtml).toContain('02')
    expect(previewHtml).toContain('03')
    expect(publishHtml).toContain('04')
    expect(previewHtml).toContain('character-generator-name')
    expect(previewHtml).toContain('角色名字')
    expect(previewHtml).toContain('character-generator-role')
    expect(previewHtml).toContain('Persona')
    expect(previewHtml).toContain('软件实现')
    expect(previewHtml).toContain('读取当前世界')
    expect(previewHtml).toContain('仅表示角色希望使用')
  })

  it('requires an explicit publish button and states that publish does not install, recruit or send chat', () => {
    const html = renderToStaticMarkup(createElement(PublishStep, {
      draft, source: 'AI 工程师', avatar: { kind: 'builtin', id: 'official-archivist' }, catalog,
      publishing: false, published: false, onBack: vi.fn(), onPublish: vi.fn(), onViewInstall: vi.fn(),
    }))
    expect(html).toContain('确认发布角色模板')
    expect(html).toContain('发布到角色市场')
    expect(html).toContain('发布不会自动安装、招募角色或发送消息')
    expect(html).not.toContain('自动安装成功')
  })

  it('keeps a visible custom-role entry in the role market rather than a hidden test-only control', () => {
    const world = {
      id: 'world-1', workspaceId: 'workspace-1', name: '我的世界', templateId: 'personal-world',
      status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      workspaceId: 'workspace-1', initialMarket: 'talent', world, worlds: [world], items: [], installed: [], transactions: [],
      loading: false, installing: false, onClose: vi.fn(), onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(), onInstallMarketplace: vi.fn(async () => undefined), onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined), onUsePlugin: vi.fn(), onPreview: vi.fn(), onInstall: vi.fn(async () => undefined),
    } as any))
    expect(html).toContain('自定义角色')
    expect(html).not.toContain('sr-only')
  })
})
