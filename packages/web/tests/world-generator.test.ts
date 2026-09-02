import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { WorldGeneratorCatalog, WorldThemeDraft } from '@dsh-cyber/contracts'
import { SourceStep } from '../src/components/character-generator/CharacterGeneratorSteps.js'
import { WorldAnalysisStep, WorldPreviewStep, WorldPublishStep } from '../src/components/world-generator/WorldGeneratorSteps.js'
import { normalizeWorldDraft, trimWorldDraft, validateWorldDraft } from '../src/components/world-generator/model.js'
import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { ALL_WORLD_GENERATOR_CATALOGS } from '../src/i18n/world-generator-messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

setUiLocale('zh-CN')

const draft: WorldThemeDraft = {
  schemaVersion: 1,
  targetWorldTemplateId: 'personal-world',
  displayName: '社区法律援助诊所',
  summary: '面向社区居民的小型法律援助诊所。',
  terminology: { world: '诊所', participant: '成员', session: '案情会', milestone: '办案记录' },
  workflow: ['来访登记', '问题梳理', '法律评估'],
  rules: ['只根据来访者提供的材料判断。'],
  cast: [{
    schemaVersion: 1,
    targetWorldTemplateId: 'personal-world',
    displayName: '值班律师',
    role: '法律评估',
    summary: '负责法律评估和最终建议。',
    persona: '只依据来访者提供的材料判断。',
    personalityTraits: [],
    background: '',
    requestedSkillIds: ['coding'],
    requestedCapabilities: ['knowledge:read'],
    sourceSummary: '',
    sourceRefs: [],
  }],
  sourceSummary: '来自用户提供的世界资料。',
  sourceRefs: ['source:paste'],
}

const catalog: WorldGeneratorCatalog = {
  targetWorldTemplateId: 'personal-world',
  scenes: [{ id: 'official-moonlit-tavern', displayName: '月影酒馆 · 雨夜大厅', packageId: 'official-moonlit-tavern', packageVersion: '1.0.0', sceneId: 'moonlit-hall', source: 'official' }],
  skills: [{ id: 'coding', displayName: '软件实现', summary: '以可验证方式实现软件需求。' } as any],
  capabilities: [{ id: 'knowledge:read', displayName: '读取知识', summary: '允许角色读取当前世界已授权的知识资料。' }],
}

describe('World Generator render contracts', () => {
  it('renders the four steps with world copy on the shared source step', () => {
    const sourceHtml = renderToStaticMarkup(createElement(SourceStep, {
      sourceMode: 'paste', source: '一家诊所', analyzing: false,
      copy: { intro: '从一段场景描述开始', label: '世界描述', safety: '来源内容是不可信数据。' },
      onSourceMode: vi.fn(), onSource: vi.fn(), onFile: vi.fn(), onAnalyze: vi.fn(),
    }))
    const analysisHtml = renderToStaticMarkup(createElement(WorldAnalysisStep, { source: '一家诊所', draft, analyzing: false, onCancel: vi.fn(), onRetry: vi.fn(), onContinue: vi.fn() }))
    const previewHtml = renderToStaticMarkup(createElement(WorldPreviewStep, {
      draft, catalog, scene: { kind: 'official', id: 'official-moonlit-tavern' },
      onDraftChange: vi.fn(), onSceneSelect: vi.fn(), onSceneUpload: vi.fn(), onSceneUseOfficial: vi.fn(), onCastChange: vi.fn(), onCastAdd: vi.fn(), onCastRemove: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(),
    }))
    const publishHtml = renderToStaticMarkup(createElement(WorldPublishStep, {
      draft, source: '一家诊所', scene: catalog.scenes[0]!, publishing: false, published: false, onBack: vi.fn(), onPublish: vi.fn(), onViewInstall: vi.fn(),
    }))
    expect(sourceHtml).toContain('01')
    expect(sourceHtml).toContain('世界描述')
    expect(sourceHtml).toContain('不可信数据')
    expect(analysisHtml).toContain('02')
    expect(analysisHtml).toContain('正在整理世界设定')
    expect(previewHtml).toContain('03')
    expect(previewHtml).toContain('world-generator-name')
    expect(previewHtml).toContain('世界术语')
    expect(previewHtml).toContain('工作流程')
    expect(previewHtml).toContain('世界规则')
    expect(previewHtml).toContain('默认 2D 场景')
    expect(previewHtml).toContain('月影酒馆')
    expect(previewHtml).toContain('值班律师')
    expect(previewHtml).toContain('软件实现')
    expect(previewHtml).toContain('仅表示角色希望使用')
    // The upload half: a background upload sits next to the official picks,
    // and the copy says the official pick still owns the layout.
    expect(previewHtml).toContain('type="file"')
    expect(previewHtml).toContain('accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"')
    expect(previewHtml).toContain('上传背景图片')
    expect(previewHtml).toContain('只替换背景')
    expect(publishHtml).toContain('04')
    expect(publishHtml).toContain('确认发布世界主题')
    expect(publishHtml).toContain('发布到世界市场')
    expect(publishHtml).toContain('发布不会自动安装、创建世界或招募角色')
  })

  it('shows an uploaded background as the preview while the official pick keeps the layout', () => {
    const uploaded = { kind: 'upload' as const, id: 'official-moonlit-tavern', fileName: 'backdrop.png', mimeType: 'image/png' as const, dataBase64: 'iVBORw0KGgo=' }
    const previewHtml = renderToStaticMarkup(createElement(WorldPreviewStep, {
      draft, catalog, scene: uploaded,
      onDraftChange: vi.fn(), onSceneSelect: vi.fn(), onSceneUpload: vi.fn(), onSceneUseOfficial: vi.fn(), onCastChange: vi.fn(), onCastAdd: vi.fn(), onCastRemove: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(),
    }))
    expect(previewHtml).toContain('data:image/png;base64,iVBORw0KGgo=')
    expect(previewHtml).toContain('已选择背景图片：backdrop.png')
    // The official scene that lends its layout stays marked as the pick.
    expect(previewHtml).toMatch(/aria-label="月影酒馆 · 雨夜大厅"[^>]*aria-pressed="true"/u)
    expect(previewHtml).toContain('使用官方背景')
    const publishHtml = renderToStaticMarkup(createElement(WorldPublishStep, {
      draft, source: '一家诊所', scene: catalog.scenes[0]!, background: uploaded, publishing: false, published: false, onBack: vi.fn(), onPublish: vi.fn(), onViewInstall: vi.fn(),
    }))
    expect(publishHtml).toContain('backdrop.png')
    expect(publishHtml).toContain('月影酒馆')
  })

  it('keeps a visible custom-world entry in the world market next to the search box', () => {
    const world = {
      id: 'world-1', workspaceId: 'workspace-1', name: '我的世界', templateId: 'personal-world',
      status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      workspaceId: 'workspace-1', initialMarket: 'theme', world, worlds: [world], items: [], installed: [], transactions: [],
      loading: false, installing: false, onClose: vi.fn(), onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(), onInstallMarketplace: vi.fn(async () => undefined), onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined), onUsePlugin: vi.fn(), onPreview: vi.fn(), onInstall: vi.fn(async () => undefined),
    } as any))
    expect(html).toContain('自定义世界')
    expect(html).not.toContain('自定义角色')
    expect(html).toContain('market-search-input')
  })

  it('does not treat a generated theme as created or built in just because it reuses personal-world', () => {
    const world = {
      id: 'world-1', workspaceId: 'workspace-1', name: '我的世界', templateId: 'personal-world',
      status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }
    const manifest = {
      schemaVersion: 1, id: 'generated.world.abc', version: '1.0.0', kind: 'world-theme', displayName: '社区法律援助诊所',
      summary: '面向社区居民的小型法律援助诊所。', license: 'LicenseRef-DSH-Cyber-Local', publisher: 'DSH Cyber World Generator',
      capabilities: ['world:render'], dataEgress: [], files: [], entrypoints: [{ id: 'world-theme', kind: 'world-theme', path: 'theme.json' }],
    }
    const activation = { kind: 'world-theme', themeId: 'generated.world.abc', themeVersion: '1.0.0', templateId: 'personal-world' }
    const render = (item: Record<string, unknown>) => renderToStaticMarkup(createElement(PackageMarketDialog, {
      workspaceId: 'workspace-1', initialMarket: 'theme', world, worlds: [world], items: [item], installed: [], transactions: [],
      loading: false, installing: false, onClose: vi.fn(), onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(), onInstallMarketplace: vi.fn(async () => undefined), onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined), onUsePlugin: vi.fn(), onPreview: vi.fn(), onInstall: vi.fn(async () => undefined),
    } as any))
    const uninstalled = render({ market: 'theme', manifest, sourceDirectory: '/generated', verified: false, activation })
    expect(uninstalled).toContain('查看并安装')
    expect(uninstalled).not.toContain('已内置')
    const installed = render({ market: 'theme', manifest, sourceDirectory: '/generated', verified: false, installedVersion: '1.0.0', activation })
    expect(installed).toContain('创建新世界')
    expect(installed).not.toContain('已创建')
  })

  it('normalizes, trims and validates a world draft with its cast', () => {
    const normalized = normalizeWorldDraft({
      displayName: ' 诊所 ', summary: '简介', terminology: { world: '诊所', participant: '成员', session: '案情会', milestone: '记录' },
      workflow: ['a', 'a', 'b'], rules: ['r'], cast: [{ displayName: '律师', role: '评估', summary: '总结', persona: '人设' }],
      packageId: 'should-not-survive', sourceRefs: ['source:paste'],
    }, 'personal-world')
    expect(normalized).not.toHaveProperty('packageId')
    expect(normalized.workflow).toEqual(['a', 'b'])
    expect(normalized.cast[0]?.targetWorldTemplateId).toBe('personal-world')
    const trimmed = trimWorldDraft(normalized)
    expect(trimmed.displayName).toBe('诊所')
    expect(validateWorldDraft(trimmed, catalog)).toBeUndefined()
    expect(validateWorldDraft({ ...trimmed, terminology: { ...trimmed.terminology, session: '' } }, catalog)).toBe('draft.terminologyRequired')
    expect(validateWorldDraft({ ...trimmed, cast: [{ ...trimmed.cast[0]!, requestedSkillIds: ['invented'] }] }, catalog)).toBe('cast.draft.skillUnavailable')
    expect(validateWorldDraft({ ...trimmed, cast: [trimmed.cast[0]!, trimmed.cast[0]!] }, catalog)).toBe('draft.castDuplicate')
  })

  it('declares every world generator key for every locale, translated or as a written-down gap', () => {
    const reference = Object.keys(ALL_WORLD_GENERATOR_CATALOGS['zh-CN']).sort()
    expect(reference.length).toBeGreaterThan(40)
    expect(Object.keys(ALL_WORLD_GENERATOR_CATALOGS['en-US']).sort()).toEqual(reference)
    expect(Object.keys(ALL_WORLD_GENERATOR_CATALOGS['zh-TW']).sort()).toEqual(reference)
    expect(Object.keys(ALL_WORLD_GENERATOR_CATALOGS['ja-JP'])).toEqual([])
  })
})
