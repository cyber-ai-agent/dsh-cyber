import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'
import { ThemeCustomizerDialog } from '../src/components/ThemeCustomizerDialog.js'
import { setUiLocale } from '../src/i18n/runtime.js'

describe('ThemeCustomizerDialog assets', () => {
  it('uses local image uploads and one shared scene instead of path fields', () => {
    setUiLocale('zh-CN')
    const world: World = {
      id: 'world-theme-upload', workspaceId: 'workspace-theme-upload', name: '上传测试世界',
      templateId: 'personal-world', status: 'active',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    }
    const html = renderToStaticMarkup(createElement(ThemeCustomizerDialog, {
      world, initialThemeId: 'default', onClose: vi.fn(), onSaved: vi.fn(),
    }))
    expect(html).toContain('统一全景场景')
    expect(html).toContain('选择图片')
    expect(html).toContain('type="file"')
    expect(html).not.toContain('World Map URL')
    expect(html).not.toContain('/assets/...')
    expect(html).not.toContain('自定义图片 URL')
  })
})
