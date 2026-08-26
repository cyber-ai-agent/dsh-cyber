import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'

import type { InstalledPluginCommand } from '@dsh-cyber/contracts'

import { CommandPicker } from '../src/components/CommandPicker.js'

const command = (overrides: Partial<InstalledPluginCommand> = {}): InstalledPluginCommand => ({
  packageId: 'official-research-brief',
  packageVersion: '1.0.0',
  displayName: '研究简报',
  summary: '整理研究',
  trigger: '/research',
  displayTrigger: '/研究',
  description: '整理结论和证据',
  automatic: false,
  ...overrides,
})

describe('CommandPicker', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('stays out of the composer until slash is entered', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, {
      commands: [command()],
      draft: '普通消息',
      onDraftChange: () => undefined,
      onFocus: () => undefined,
    }))
    expect(markup).toBe('')
  })

  it('shows expandable command, skill and plugin categories', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, {
      commands: [command(), command({ packageId: 'automatic', trigger: 'always', automatic: true })],
      draft: '/',
      onDraftChange: () => undefined,
      onFocus: () => undefined,
    }))
    expect(markup).toContain('斜杠操作')
    expect(markup).toContain('命令')
    expect(markup).toContain('技能')
    expect(markup).toContain('插件')
    expect(markup).not.toContain('研究简报')
    expect(markup).not.toContain('automatic')
    expect(markup).not.toContain('自动运行')
    expect(markup).not.toContain('命令选择器')
  })

  it('opens the second-level plugin list from a category', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(CommandPicker, { commands: [command()], draft: '/', onDraftChange: () => undefined, onFocus: () => undefined })) })
    const pluginCategory = Array.from(host.querySelectorAll<HTMLButtonElement>('.composer-plugin-picker__category')).find((item) => item.textContent?.includes('插件'))
    expect(pluginCategory).toBeDefined()
    await act(async () => { pluginCategory?.click() })
    expect(host.textContent).toContain('研究简报')
    expect(host.querySelector('[aria-label="返回斜杠分类"]')).toBeTruthy()
    expect(host.textContent).not.toContain('命令切换')
    await act(async () => { root.unmount() })
  })
})
