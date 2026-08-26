import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { InstalledPluginCommand } from '@dsh-cyber/contracts'

import { CommandPicker } from '../src/components/CommandPicker.js'

const command = (overrides: Partial<InstalledPluginCommand> = {}): InstalledPluginCommand => ({
  packageId: 'official-research-brief',
  packageVersion: '1.0.0',
  displayName: '研究简报',
  summary: '整理研究',
  trigger: '/research',
  displayTrigger: '/研究',
  description: '整理结论和证据。',
  automatic: false,
  ...overrides,
})

describe('CommandPicker', () => {
  it('stays out of the composer until slash is entered', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, {
      commands: [command()],
      draft: '普通消息',
      onDraftChange: () => undefined,
      onFocus: () => undefined,
    }))
    expect(markup).toBe('')
  })

  it('only exposes explicit commands from the slash menu', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, {
      commands: [command(), command({ packageId: 'automatic', trigger: 'always', automatic: true })],
      draft: '/',
      onDraftChange: () => undefined,
      onFocus: () => undefined,
    }))
    expect(markup).toContain('斜杠操作')
    expect(markup).toContain('研究简报')
    expect(markup).not.toContain('automatic')
    expect(markup).not.toContain('自动运行')
    expect(markup).not.toContain('命令选择器')
  })

  it('filters operations by the text after slash', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, { commands: [command(), command({ packageId: 'official-decision-log', displayName: '决策记录', summary: '整理背景', trigger: '/decision-log', displayTrigger: '/决策', description: '整理背景、决策与取舍。' })], draft: '/研究', onDraftChange: () => undefined, onFocus: () => undefined }))
    expect(markup).toContain('研究简报')
    expect(markup).not.toContain('决策记录')
    expect(markup).toContain('选择后放回消息输入框')
  })
})
