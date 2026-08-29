import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'
import { ThemeCustomizerDialog } from '../src/components/ThemeCustomizerDialog.js'
import { setUiLocale } from '../src/i18n/runtime.js'

describe('ThemeCustomizerDialog assets', () => {
  it('uses local image uploads for conversation Skin assets without claiming the World Scene', () => {
    setUiLocale('zh-CN')
    const world: World = {
      id: 'world-theme-upload', workspaceId: 'workspace-theme-upload', name: '上传测试世界',
      templateId: 'personal-world', status: 'active',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    }
    const html = renderToStaticMarkup(createElement(ThemeCustomizerDialog, {
      world, initialThemeId: 'default', onClose: vi.fn(), onSaved: vi.fn(),
    }))
    expect(html).toContain('会话背景')
    expect(html).toContain('世界场景')
    expect(html).toContain('选择图片')
    expect(html).toContain('type="file"')
    expect(html).not.toContain('统一全景场景')
    expect(html).not.toContain('同一张图片用于聊天背景与 2.5D 世界')
    expect(html).not.toContain('World Map URL')
    expect(html).not.toContain('/assets/...')
    expect(html).not.toContain('自定义图片 URL')
  })
})
