import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { PluginDraft, PluginGeneratorCatalog } from '../src/components/plugin-generator/model.js'
import { SourceStep } from '../src/components/character-generator/CharacterGeneratorSteps.js'
import { PluginAnalysisStep, PluginPreviewStep, PluginPublishStep } from '../src/components/plugin-generator/PluginGeneratorSteps.js'
import { normalizePluginDraft, previewPrompt, trimPluginDraft, validatePluginDraft } from '../src/components/plugin-generator/model.js'
import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { ALL_PLUGIN_GENERATOR_CATALOGS } from '../src/i18n/plugin-generator-messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

setUiLocale('zh-CN')

const draft: PluginDraft = {
  schemaVersion: 1,
  displayName: '每周复盘助手',
  summary: '把一周的会话和任务整理成可追溯的复盘要点。',
  transforms: [{
    id: 'weekly-review',
    trigger: '/weekly-review',
    description: '整理本周复盘要点。',
    instruction: '你是本周复盘助手。只依据当前会话和任务中的事实，按进展、阻碍、下周计划三段整理要点。',
    mode: 'prepend',
    priority: 50,
  }],
  sourceSummary: '来自用户提供的提示词配方。',
  sourceRefs: ['source:paste'],
}

const catalog: PluginGeneratorCatalog = {
  limits: { maxTransforms: 64, maxIdLength: 64, maxTriggerLength: 64, maxDescriptionLength: 200, maxInstructionLength: 2000 },
  modes: ['prepend', 'append', 'replace'],
  reservedTriggers: [{ trigger: '/meeting-summary', packageId: 'official-meeting-notes', displayName: '会议纪要助手' }],
}

const previewHandlers = { onDraftChange: vi.fn(), onTransformChange: vi.fn(), onAddTransform: vi.fn(), onRemoveTransform: vi.fn(), onBack: vi.fn(), onContinue: vi.fn() }

describe('Plugin Generator render contracts', () => {
  it('renders the four steps with plugin copy on the shared source step', () => {
    const sourceHtml = renderToStaticMarkup(createElement(SourceStep, {
      sourceMode: 'paste', source: '每周复盘', analyzing: false,
      copy: { intro: '从一段提示词配方开始', label: '提示词配方', safety: '来源内容是不可信数据。' },
      onSourceMode: vi.fn(), onSource: vi.fn(), onFile: vi.fn(), onAnalyze: vi.fn(),
    }))
    const analysisHtml = renderToStaticMarkup(createElement(PluginAnalysisStep, { source: '每周复盘', draft, analyzing: false, onCancel: vi.fn(), onRetry: vi.fn(), onContinue: vi.fn() }))
    const previewHtml = renderToStaticMarkup(createElement(PluginPreviewStep, { draft, catalog, ...previewHandlers }))
    const publishHtml = renderToStaticMarkup(createElement(PluginPublishStep, {
      draft, source: '每周复盘', publishing: false, published: false, onBack: vi.fn(), onPublish: vi.fn(), onViewInstall: vi.fn(),
    }))
    expect(sourceHtml).toContain('01')
    expect(sourceHtml).toContain('提示词配方')
    expect(sourceHtml).toContain('不可信数据')
    expect(analysisHtml).toContain('02')
    expect(analysisHtml).toContain('正在整理指令')
    expect(analysisHtml).toContain('/weekly-review')
    expect(analysisHtml).toContain('1 条指令')
    expect(previewHtml).toContain('03')
    expect(previewHtml).toContain('plugin-generator-name')
    expect(previewHtml).toContain('触发词')
    expect(previewHtml).toContain('/weekly-review')
    expect(previewHtml).toContain('前置到消息前')
    // The transform is shown as the user will get it: trigger, mode and the composed runtime prompt.
    expect(previewHtml).toContain('效果预览')
    expect(previewHtml).toContain('角色实际收到')
    expect(previewHtml).toContain('你是本周复盘助手。只依据当前会话和任务中的事实')
    expect(previewHtml).toContain('/weekly-review 请整理本周的会话。')
    // No upload control and no way to type a capability, a file or a URL: only the six transform fields.
    expect(previewHtml).not.toContain('type="file"')
    expect(previewHtml).not.toContain('capabilities')
    expect(publishHtml).toContain('04')
    expect(publishHtml).toContain('确认发布插件')
    expect(publishHtml).toContain('发布到插件市场')
    expect(publishHtml).toContain('发布不会自动安装插件')
    expect(publishHtml).toContain('/weekly-review')
  })

  it('flags a trigger an official plugin already owns before publish', () => {
    const reserved: PluginDraft = { ...draft, transforms: [{ ...draft.transforms[0]!, trigger: '/meeting-summary' }] }
    const html = renderToStaticMarkup(createElement(PluginPreviewStep, { draft: reserved, catalog, ...previewHandlers }))
    expect(html).toContain('会议纪要助手')
    expect(html).toContain('请换一个')
    expect(validatePluginDraft(reserved, catalog)).toBe('transform.triggerReserved')
  })

  it('keeps a visible custom-plugin entry in the plugin market next to the search box', () => {
    const world = {
      id: 'world-1', workspaceId: 'workspace-1', name: '我的世界', templateId: 'personal-world',
      status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      workspaceId: 'workspace-1', initialMarket: 'plugin', world, worlds: [world], items: [], installed: [], transactions: [],
      loading: false, installing: false, onClose: vi.fn(), onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(), onInstallMarketplace: vi.fn(async () => undefined), onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined), onUsePlugin: vi.fn(), onPreview: vi.fn(), onInstall: vi.fn(async () => undefined),
    } as any))
    expect(html).toContain('自定义插件')
    expect(html).not.toContain('自定义角色')
    expect(html).not.toContain('自定义世界')
    expect(html).not.toContain('自定义皮肤')
    expect(html).toContain('market-search-input')
  })

  it('normalizes, trims and validates a plugin draft against the trigger rule and the catalog limits', () => {
    const normalized = normalizePluginDraft({
      displayName: ' 复盘 ', summary: '简介',
      capabilities: ['integration:http'], dataEgress: ['https://evil.example'], kind: 'skill', packageId: 'should-not-survive',
      transforms: [
        { trigger: '/Weekly-Review', description: ' 说明 ', instruction: ' 内容 ', mode: 'inject', priority: 1.5, capabilities: ['integration:http'], path: '/etc/passwd' },
        'junk',
      ],
      sourceRefs: ['source:paste'],
    })
    expect(normalized).not.toHaveProperty('capabilities')
    expect(normalized).not.toHaveProperty('dataEgress')
    expect(normalized).not.toHaveProperty('kind')
    expect(normalized).not.toHaveProperty('packageId')
    expect(normalized.transforms).toHaveLength(1)
    expect(Object.keys(normalized.transforms[0]!).sort()).toEqual(['description', 'id', 'instruction', 'mode', 'priority', 'trigger'])
    // A mode or priority the host cannot read becomes the default for review, never a value passed through.
    expect(normalized.transforms[0]!.mode).toBe('prepend')
    expect(normalized.transforms[0]!.priority).toBe(0)
    const trimmed = trimPluginDraft(normalized)
    expect(trimmed.displayName).toBe('复盘')
    expect(trimmed.transforms[0]).toEqual({ id: 'weekly-review', trigger: '/weekly-review', description: '说明', instruction: '内容', mode: 'prepend', priority: 0 })
    expect(validatePluginDraft(trimmed, catalog)).toBeUndefined()
    const withTrigger = (trigger: string): PluginDraft => ({ ...trimmed, transforms: [{ ...trimmed.transforms[0]!, trigger }] })
    expect(validatePluginDraft(withTrigger('weekly review'), catalog)).toBe('transform.triggerInvalid')
    expect(validatePluginDraft(withTrigger('/weekly_review'), catalog)).toBe('transform.triggerInvalid')
    expect(validatePluginDraft(withTrigger('/'), catalog)).toBe('transform.triggerInvalid')
    // Case is normalized rather than rejected here; the server only ever sees the trimmed, lowercased trigger.
    expect(validatePluginDraft(withTrigger('/Weekly'), catalog)).toBeUndefined()
    expect(trimPluginDraft(withTrigger('/Weekly')).transforms[0]!.trigger).toBe('/weekly')
    // A bare word becomes an explicit slash command: the runtime's silent `always` is unreachable from the editor.
    expect(trimPluginDraft(withTrigger('always')).transforms[0]!.trigger).toBe('/always')
    expect(validatePluginDraft(withTrigger('/meeting-summary'), catalog)).toBe('transform.triggerReserved')
    expect(validatePluginDraft({ ...trimmed, transforms: [trimmed.transforms[0]!, { ...trimmed.transforms[0]!, id: 'again' }] }, catalog)).toBe('transform.triggerDuplicate')
    expect(validatePluginDraft({ ...trimmed, transforms: [] }, catalog)).toBe('draft.transformsEmpty')
    expect(validatePluginDraft({ ...trimmed, transforms: Array.from({ length: 65 }, (_, index) => ({ ...trimmed.transforms[0]!, trigger: `/t-${index}` })) }, catalog)).toBe('draft.transformsTooMany')
    expect(validatePluginDraft({ ...trimmed, transforms: [{ ...trimmed.transforms[0]!, instruction: '' }] }, catalog)).toBe('transform.instructionRequired')
    expect(validatePluginDraft({ ...trimmed, transforms: [{ ...trimmed.transforms[0]!, instruction: '长'.repeat(2001) }] }, catalog)).toBe('transform.instructionTooLong')
    expect(validatePluginDraft({ ...trimmed, transforms: [{ ...trimmed.transforms[0]!, description: '' }] }, catalog)).toBe('transform.descriptionRequired')
    expect(validatePluginDraft({ ...trimmed, displayName: '' }, catalog)).toBe('draft.displayNameRequired')
    // The effect preview composes exactly the way the runtime does.
    const transform = trimmed.transforms[0]!
    expect(previewPrompt(transform, '/weekly-review 请整理')).toBe('内容\n\n/weekly-review 请整理')
    expect(previewPrompt({ ...transform, mode: 'append' }, '/weekly-review 请整理')).toBe('/weekly-review 请整理\n\n内容')
    expect(previewPrompt({ ...transform, mode: 'replace' }, '/weekly-review 请整理')).toBe('内容')
  })

  it('declares every plugin generator key for every locale, translated or as a written-down gap', () => {
    const reference = Object.keys(ALL_PLUGIN_GENERATOR_CATALOGS['zh-CN']).sort()
    expect(reference.length).toBeGreaterThan(40)
    expect(Object.keys(ALL_PLUGIN_GENERATOR_CATALOGS['en-US']).sort()).toEqual(reference)
    expect(Object.keys(ALL_PLUGIN_GENERATOR_CATALOGS['zh-TW'])).toEqual([])
    expect(Object.keys(ALL_PLUGIN_GENERATOR_CATALOGS['ja-JP'])).toEqual([])
  })
})
