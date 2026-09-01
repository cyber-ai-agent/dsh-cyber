import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewStep, SourceStep } from '../src/components/character-generator/CharacterGeneratorSteps.js'
import { CharacterGenerator } from '../src/components/character-generator/CharacterGenerator.js'
import { PackageMarketDialog } from '../src/components/PackageMarketDialog.js'
import { ALL_CHARACTER_GENERATOR_CATALOGS } from '../src/i18n/character-generator-messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

// Chinese is the product's primary language, so these contracts are asserted
// against the copy real users read.
setUiLocale('zh-CN')

const cssPath = join(process.cwd(), 'packages', 'web', 'src', 'components', 'character-generator', 'CharacterGenerator.css')
const css = readFileSync(cssPath, 'utf8')

function ruleBody(selector: string): string {
  const index = css.indexOf(`\n${selector} {`)
  expect(index, `missing CSS rule for ${selector}`).toBeGreaterThan(-1)
  return css.slice(index, css.indexOf('}', index))
}

const draft = {
  schemaVersion: 1,
  targetWorldTemplateId: 'personal-world',
  displayName: 'AI 工程师',
  role: '机器学习工程师',
  summary: '从数据到上线构建可靠的 AI 系统。',
  persona: '只依据当前世界中可验证的工程证据工作。',
  personalityTraits: ['务实'],
  background: '',
  requestedSkillIds: [],
  requestedCapabilities: [],
  sourceSummary: '来自 Markdown 角色资料。',
  sourceRefs: [],
} as any

const catalog = { skills: [], capabilities: [], avatars: [] } as any

const world = {
  id: 'world-1', workspaceId: 'workspace-1', name: '我的世界', templateId: 'personal-world',
  status: 'active', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
} as any

describe('Character Generator layout contract', () => {
  // The step body, the catalog banner and the back link are all conditional.
  // A fixed `grid-template-rows` track list assigns rows by child index, so the
  // scroller and the back link land in the wrong tracks whenever one of the
  // optional rows is absent — which is the normal case once the catalog loads.
  it('sizes the scrolling step body independently of how many optional rows render', () => {
    const shell = ruleBody('.character-generator')
    expect(shell).toContain('display: flex')
    expect(shell).toContain('flex-direction: column')
    expect(shell).not.toContain('grid-template-rows')

    const body = ruleBody('.character-generator__body')
    expect(body).toContain('flex: 1')
    expect(body).toContain('min-height: 0')
    expect(body).toContain('overflow: auto')
  })

  it('keeps the back link a fixed-height flex row rather than a grid track', () => {
    const backLink = ruleBody('.character-generator__back-link')
    expect(backLink).toContain('flex: 0 0 auto')
    expect(backLink).not.toContain('justify-self')
  })

  it('anchors the visually hidden file inputs to their own label so focus does not scroll the dialog', () => {
    expect(ruleBody('.character-generator-file-picker')).toContain('position: relative')
    expect(ruleBody('.character-generator-upload-button')).toContain('position: relative')
    // The clip pattern keeps the input focusable; `display: none` would not.
    expect(ruleBody('.character-generator-file-picker input')).not.toContain('display: none')
    expect(ruleBody('.character-generator-upload-button input')).not.toContain('display: none')
    expect(css).toContain('.character-generator-file-picker:focus-within')
    expect(css).toContain('.character-generator-upload-button:focus-within')
  })

  it('does not waste the ultra-wide market dialog on a 1080px column', () => {
    expect(css).toContain('.package-market-dialog--catalog.is-character-generator')
  })
})

describe('Character Generator field labelling', () => {
  it('gives the personality trait input an accessible name, not only a placeholder', () => {
    const html = renderToStaticMarkup(createElement(PreviewStep as any, {
      draft, catalog, avatar: undefined,
      onDraftChange: vi.fn(), onAvatarSelect: vi.fn(), onAvatarUpload: vi.fn(), onBack: vi.fn(), onContinue: vi.fn(),
    }))
    const traitInput = html.slice(html.indexOf('character-generator-trait-input'))
    const openTag = traitInput.slice(traitInput.indexOf('<input'), traitInput.indexOf('>', traitInput.indexOf('<input')))
    expect(openTag).toMatch(/aria-label="[^"]+"|id="character-generator-trait"/)
  })

  it('states the import hint once instead of repeating it verbatim in the action row', () => {
    const html = renderToStaticMarkup(createElement(SourceStep as any, {
      sourceMode: 'file', source: '', sourceFileName: undefined, analyzing: false,
      onSourceMode: vi.fn(), onSource: vi.fn(), onFile: vi.fn(), onAnalyze: vi.fn(),
    }))
    const hint = '支持 Markdown 或纯文本。导入内容会作为数据分析，不会获得系统指令或权限。'
    expect(html.split(hint)).toHaveLength(2)
  })
})

describe('Character Generator locale catalogs', () => {
  it('translates the generator-opening message in every supported locale', () => {
    for (const [locale, messages] of Object.entries(ALL_CHARACTER_GENERATOR_CATALOGS)) {
      expect((messages as Record<string, string>).opening, locale).toBeTypeOf('string')
    }
  })
})

describe('Character Generator dirty-draft confirmation', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ skills: [], capabilities: [], avatars: [] }), { status: 200, headers: { 'content-type': 'application/json' } })))
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  const render = async (closeRequest: number, onClose: () => void) => {
    await act(async () => {
      root.render(createElement(CharacterGenerator, {
        workspaceId: 'workspace-1', targetWorld: world, closeRequest,
        onClose, onPublished: vi.fn(),
      } as any))
    })
  }

  it('asks before discarding a dirty draft and moves focus into the confirmation', async () => {
    const onClose = vi.fn()
    await render(0, onClose)
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '一个角色')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await render(1, onClose)

    const prompt = host.querySelector('.character-generator-discard')!
    expect(prompt).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(prompt.getAttribute('role')).toBe('alertdialog')
    expect(prompt.getAttribute('aria-modal')).toBe('true')
    expect(prompt.getAttribute('aria-labelledby')).toBeTruthy()
    // Focus must land on the non-destructive option inside the confirmation.
    expect(prompt.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent).toContain('继续编辑')
  })

  it('traps Tab inside the confirmation and treats Escape as keep editing', async () => {
    const onClose = vi.fn()
    await render(0, onClose)
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '一个角色')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await render(1, onClose)

    const prompt = host.querySelector('.character-generator-discard')!
    const buttons = [...prompt.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)

    buttons[1]!.focus()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(buttons[0])

    buttons[0]!.focus()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(buttons[1])

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host.querySelector('.character-generator-discard')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // Focus goes back to whatever the author was editing.
    expect(document.activeElement).toBe(host.querySelector('textarea'))
  })

  it('closes without a prompt when nothing has been entered', async () => {
    const onClose = vi.fn()
    await render(0, onClose)
    await render(1, onClose)
    expect(host.querySelector('.character-generator-discard')).toBeNull()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('Character Generator entry and exit focus', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ skills: [], capabilities: [], avatars: [] }), { status: 200, headers: { 'content-type': 'application/json' } })))
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  const marketProps = {
    workspaceId: 'workspace-1', initialMarket: 'talent', world, worlds: [world], items: [], installed: [], transactions: [],
    loading: false, installing: false, onClose: vi.fn(), onSearch: vi.fn(async () => undefined),
    onPreviewMarketplace: vi.fn(), onInstallMarketplace: vi.fn(async () => undefined), onCreateThemeWorld: vi.fn(async () => undefined),
    onRecruitTalent: vi.fn(async () => undefined), onUsePlugin: vi.fn(), onPreview: vi.fn(), onInstall: vi.fn(async () => undefined),
  } as any

  it('says it is opening the generator rather than reusing the analysis progress copy', async () => {
    await act(async () => { root.render(createElement(PackageMarketDialog, marketProps)) })
    const trigger = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('自定义角色'))!
    act(() => { trigger.click() })
    const fallback = host.querySelector('.dialog-loading')
    expect(fallback?.textContent).not.toContain('正在读取来源并匹配可用能力')
    expect(fallback?.textContent).toContain('正在打开角色创建器')
    await act(async () => { await Promise.resolve() })
  })

  it('returns focus to the custom-role trigger when the generator closes', async () => {
    await act(async () => { root.render(createElement(PackageMarketDialog, marketProps)) })
    const trigger = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('自定义角色'))!
    trigger.focus()
    await act(async () => { trigger.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.querySelector('.character-generator')).not.toBeNull()

    // Nothing has been typed, so Escape closes the generator outright.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(host.querySelector('.character-generator')).toBeNull()
    const reopened = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('自定义角色'))
    expect(document.activeElement).toBe(reopened)
  })
})
