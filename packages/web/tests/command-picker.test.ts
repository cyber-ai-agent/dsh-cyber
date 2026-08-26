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
  it('only exposes explicit commands and keeps skills/automatic transforms out', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, {
      commands: [command(), command({ packageId: 'automatic', trigger: 'always', automatic: true })],
      draft: '',
      onDraftChange: () => undefined,
      onFocus: () => undefined,
    }))
    expect(markup).toContain('命令')
    expect(markup).toContain('研究简报')
    expect(markup).not.toContain('automatic')
    expect(markup).not.toContain('自动运行')
    expect(markup).not.toContain('插件')
  })

  it('explains that selecting a command only fills the composer', () => {
    const markup = renderToStaticMarkup(createElement(CommandPicker, { commands: [command()], draft: '', onDraftChange: () => undefined, onFocus: () => undefined }))
    expect(markup).toContain('不会自动发送')
    expect(markup).toContain('打开命令选择器')
  })
})
