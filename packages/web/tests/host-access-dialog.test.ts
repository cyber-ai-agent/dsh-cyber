import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConversationHostAccessDialog } from '../src/components/ConversationHostAccessDialog.js'

describe('ConversationHostAccessDialog', () => {
  it('presents full access as a current-session confirmation', () => {
    const markup = renderToStaticMarkup(createElement(ConversationHostAccessDialog, {
      request: { worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-1'], employeeNames: ['阿开'] },
      onConfirm: async () => undefined,
      onClose: () => undefined,
    }))
    expect(markup).toContain('完全访问')
    expect(markup).toContain('阿开')
    expect(markup).toContain('当前会话持续使用')
    expect(markup).toContain('允许当前会话')
    expect(markup).not.toContain('目标')
    expect(markup).not.toContain('用途')
    expect(markup).not.toContain('本次电脑访问')
    expect(markup).not.toContain('一次性')
    expect(markup).not.toContain('danger-full-access')
  })
})
