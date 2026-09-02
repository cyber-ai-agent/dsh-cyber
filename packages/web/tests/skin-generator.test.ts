import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { InstalledSkinDeclaration, SkinDraft, SkinGeneratorCatalog } from '../src/components/skin-generator/model.js'
import { SourceStep } from '../src/components/character-generator/CharacterGeneratorSteps.js'
import { SkinAnalysisStep, SkinPreviewStep, SkinPublishStep } from '../src/components/skin-generator/SkinGeneratorSteps.js'
import { normalizeSkinDraft, trimSkinDraft, validateSkinDraft } from '../src/components/skin-generator/model.js'
import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { syncInstalledSkinThemes } from '../src/features/world/installed-skin-themes.js'
import { themeRegistry } from '../src/features/world/world-themes.js'
import { ALL_SKIN_GENERATOR_CATALOGS } from '../src/i18n/skin-generator-messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

setUiLocale('zh-CN')

const draft: SkinDraft = {
  schemaVersion: 1,
  displayName: '深夜图书馆',
  summary: '深蓝底色配暖黄阅读灯的安静阅读氛围。',
  palette: {
    accentColor: '#5aa9e6',
    pageBackground: '#0b1220',
    panelBackground: '#121c2e',
    textColor: '#eef2f7',
    ownerBubbleColor: '#1f3352',
    characterBubbleColor: '#16233a',
    backdropOpacity: 0.9,
  },
  sourceSummary: '来自用户提供的皮肤描述。',
  sourceRefs: ['source:paste'],
}

const catalog: SkinGeneratorCatalog = {
  backdrops: [
    { id: 'moonlit-tavern', displayName: '月影酒馆', packageId: 'moonlit-tavern', packageVersion: '1.0.0', source: 'official' },
    { id: 'sakura-shrine', displayName: '千樱神殿', packageId: 'sakura-shrine', packageVersion: '1.0.0', source: 'official' },
  ],
}

describe('Skin Generator render contracts', () => {
  it('renders the four steps with skin copy on the shared source step', () => {
    const sourceHtml = renderToStaticMarkup(createElement(SourceStep, {
      sourceMode: 'paste', source: '深夜图书馆', analyzing: false,
      copy: { intro: '从一段风格描述开始', label: '皮肤描述', safety: '来源内容是不可信数据。' },
      onSourceMode: vi.fn(), onSource: vi.fn(), onFile: vi.fn(), onAnalyze: vi.fn(),
    }))
    const analysisHtml = renderToStaticMarkup(createElement(SkinAnalysisStep, { source: '深夜图书馆', draft, analyzing: false, onCancel: vi.fn(), onRetry: vi.fn(), onContinue: vi.fn() }))
    const previewHtml = renderToStaticMarkup(createElement(SkinPreviewStep, {
      draft, catalog, backdrop: { kind: 'official', id: 'moonlit-tavern' },
      onDraftChange: vi.fn(), onPaletteChange: vi.fn(), onBackdropSelect: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(),
    }))
    const publishHtml = renderToStaticMarkup(createElement(SkinPublishStep, {
      draft, source: '深夜图书馆', backdrop: catalog.backdrops[0]!, publishing: false, published: false, onBack: vi.fn(), onPublish: vi.fn(), onViewInstall: vi.fn(),
    }))
    expect(sourceHtml).toContain('01')
    expect(sourceHtml).toContain('皮肤描述')
    expect(sourceHtml).toContain('不可信数据')
    expect(analysisHtml).toContain('02')
    expect(analysisHtml).toContain('正在整理配色')
    expect(previewHtml).toContain('03')
    expect(previewHtml).toContain('skin-generator-name')
    expect(previewHtml).toContain('配色')
    expect(previewHtml).toContain('#5aa9e6')
    expect(previewHtml).toContain('月影酒馆')
    // The live preview is inline-styled from the palette; nothing global.
    expect(previewHtml).toContain('skin-generator-preview')
    expect(previewHtml).toContain('background-color:#0b1220')
    // No upload control: a custom backdrop bitmap is the stated follow-up.
    expect(previewHtml).not.toContain('type="file"')
    expect(publishHtml).toContain('04')
    expect(publishHtml).toContain('确认发布皮肤')
    expect(publishHtml).toContain('发布到皮肤市场')
    expect(publishHtml).toContain('发布不会自动安装或应用')
  })

  it('keeps a visible custom-skin entry in the skin market next to the search box', () => {
    const world = {
      id: 'world-1', workspaceId: 'workspace-1', name: '我的世界', templateId: 'personal-world',
      status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }
    const html = renderToStaticMarkup(createElement(PackageMarketDialog, {
      workspaceId: 'workspace-1', initialMarket: 'skin', world, worlds: [world], items: [], installed: [], transactions: [],
      loading: false, installing: false, onClose: vi.fn(), onSearch: vi.fn(async () => undefined),
      onPreviewMarketplace: vi.fn(), onInstallMarketplace: vi.fn(async () => undefined), onCreateThemeWorld: vi.fn(async () => undefined),
      onRecruitTalent: vi.fn(async () => undefined), onUsePlugin: vi.fn(), onPreview: vi.fn(), onInstall: vi.fn(async () => undefined),
    } as any))
    expect(html).toContain('自定义皮肤')
    expect(html).not.toContain('自定义角色')
    expect(html).not.toContain('自定义世界')
    expect(html).toContain('market-search-input')
  })

  it('normalizes, trims and validates a skin draft against the hex allowlist', () => {
    const normalized = normalizeSkinDraft({
      displayName: ' 图书馆 ', summary: '简介',
      palette: { accentColor: '#ABC', pageBackground: 'url(x)', panelBackground: '#121c2e', textColor: '#eef2f7', ownerBubbleColor: '#1f3352', characterBubbleColor: '#16233a', backdropOpacity: 4, customCss: 'x' },
      packageId: 'should-not-survive', sourceRefs: ['source:paste'],
    })
    expect(normalized).not.toHaveProperty('packageId')
    expect(normalized.palette).not.toHaveProperty('customCss')
    expect(normalized.palette.accentColor).toBe('#aabbcc')
    // A value the host cannot parse becomes empty for the user to fill, never passed through.
    expect(normalized.palette.pageBackground).toBe('')
    expect(normalized.palette.backdropOpacity).toBe(0.9)
    const trimmed = trimSkinDraft({ ...normalized, palette: { ...normalized.palette, pageBackground: '#0B1220' } })
    expect(trimmed.displayName).toBe('图书馆')
    expect(trimmed.palette.pageBackground).toBe('#0b1220')
    expect(validateSkinDraft(trimmed)).toBeUndefined()
    expect(validateSkinDraft({ ...trimmed, palette: { ...trimmed.palette, accentColor: 'var(--x)' } })).toBe('draft.colorInvalid')
    expect(validateSkinDraft({ ...trimmed, palette: { ...trimmed.palette, backdropOpacity: 1.5 } })).toBe('draft.opacityInvalid')
    expect(validateSkinDraft({ ...trimmed, displayName: '' })).toBe('draft.displayNameRequired')
  })

  it('registers a declared palette as a package theme and unregisters it when uninstalled', () => {
    const declared: InstalledSkinDeclaration = {
      packageId: 'generated.skin.abc', packageVersion: '1.0.0', entrypointId: 'generated.skin.abc', entrypointPath: 'skin.json',
      manifest: { schemaVersion: 1, id: 'generated.skin.abc', skinId: 'generated.skin.abc', themeId: 'generated.skin.abc', displayName: '深夜图书馆', summary: '简介', palette: draft.palette, backdropSkinId: 'moonlit-tavern' },
    }
    const official: InstalledSkinDeclaration = {
      packageId: 'neon-cyber', packageVersion: '1.0.0', entrypointId: 'neon-cyber', entrypointPath: 'skin.json',
      manifest: { schemaVersion: 1, id: 'neon-cyber', skinId: 'neon-cyber', themeId: 'neon-cyber', displayName: '霓虹电波', summary: '简介' },
    }
    syncInstalledSkinThemes([declared, official])
    const theme = themeRegistry.get('generated.skin.abc')
    expect(theme.id).toBe('generated.skin.abc')
    expect(theme.source).toBe('package')
    expect(theme.tokens.accentColor).toBe('#5aa9e6')
    expect(theme.tokens.pageBackground).toBe('#0b1220')
    // The backdrop is resolved by the host from the official skin, never from the package.
    expect(theme.tokens.backdropImage).toBe(themeRegistry.get('moonlit-tavern').tokens.backdropImage)
    expect(theme.tokens.backdropOpacity).toBe(0.9)
    expect(themeRegistry.listAvailable(['generated.skin.abc']).some((candidate) => candidate.id === 'generated.skin.abc')).toBe(true)
    // An official skin without a palette stays a built-in theme, not a duplicate package theme.
    expect(themeRegistry.get('neon-cyber').source).toBe('builtin')
    syncInstalledSkinThemes([official])
    expect(themeRegistry.get('generated.skin.abc').id).toBe('default')
  })

  it('declares every skin generator key for every locale, translated or as a written-down gap', () => {
    const reference = Object.keys(ALL_SKIN_GENERATOR_CATALOGS['zh-CN']).sort()
    expect(reference.length).toBeGreaterThan(30)
    expect(Object.keys(ALL_SKIN_GENERATOR_CATALOGS['en-US']).sort()).toEqual(reference)
    expect(Object.keys(ALL_SKIN_GENERATOR_CATALOGS['zh-TW']).sort()).toEqual(reference)
    expect(Object.keys(ALL_SKIN_GENERATOR_CATALOGS['ja-JP'])).toEqual([])
  })
})
