import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OneShotHostAccessDialog } from '../src/components/OneShotHostAccessDialog.js'

describe('OneShotHostAccessDialog', () => {
  it('presents host access as one action instead of a persistent setting', () => {
    const markup = renderToStaticMarkup(createElement(OneShotHostAccessDialog, {
      request: { worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-1'], employeeNames: ['阿开'], clientTurnId: 'turn-1', prompt: '读取当前任务指定文件', target: '当前任务指定文件', reason: '生成一次交付物' },
      onConfirm: async () => undefined,
      onClose: () => undefined,
    }))
    expect(markup).toContain('本次电脑访问')
    expect(markup).toContain('阿开')
    expect(markup).toContain('不会保存为角色或世界权限')
    expect(markup).toContain('仅允许本次任务')
    expect(markup).not.toContain('danger-full-access')
  })
})
