import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { World } from '@dsh-cyber/contracts'
import { ChatWorkbench } from '../src/components/ChatWorkbench.js'
import type { CyberEmployee } from '../src/types.js'

afterEach(() => {
  document.body.replaceChildren()
})

describe('Chat control UI', () => {
  it('keeps input controls available while showing queue and stop actions', () => {
    const employee = { id: 'employee-a', displayName: '甲角色', role: '分析', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
    const world = { id: 'world-chat-control', workspaceId: 'workspace-chat-control', name: '控制测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const html = renderToStaticMarkup(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      participantIds: [employee.id],
      messages: [],
      employees: [employee],
      pendingCount: 1,
      queuedCount: 1,
      queueItems: [
        { id: 'running', queueKey: 'direct:employee-a', worldId: world.id, employeeIds: [employee.id], title: '甲角色对话', status: 'running', createdAt: new Date().toISOString(), workTurnId: 'turn-running' },
        { id: 'approval', queueKey: 'direct:employee-a', worldId: world.id, employeeIds: [employee.id], title: '需要确认的操作', status: 'waiting-approval', createdAt: new Date().toISOString(), workTurnId: 'turn-approval' },
        { id: 'queued', queueKey: 'direct:employee-a', worldId: world.id, employeeIds: [employee.id], title: '下一条消息', status: 'queued', createdAt: new Date().toISOString() },
      ],
      draft: '继续补充条件',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
      onStopTurn: vi.fn(async () => undefined),
      onPromoteQueuedTurn: vi.fn(async () => undefined),
      onCancelQueuedTurn: vi.fn(async () => undefined),
    }))
    expect(html).toContain('正在回复中')
    expect(html).toContain('等待批准')
    expect(html).toContain('■ 停止')
    expect(html).toContain('插入')
    expect(html).toContain('撤销')
    expect(html).toContain('排队')
    expect(html).toContain('停止当前回复')
    expect(html).not.toContain('下一条执行')
    expect(html).not.toContain('打开命令选择器')
  })

  it('copies an assistant reply from its context menu', async () => {
    const employee = { id: 'employee-copy', displayName: '回复角色', role: '分析', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
    const world = { id: 'world-copy', workspaceId: 'workspace-copy', name: '复制测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const writeText = vi.fn(async (_value: string) => undefined)
    const originalClipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    try {
      await act(async () => { root.render(createElement(ChatWorkbench, {
        demoMode: false,
        world,
        messages: [{ id: 'assistant-copy', sessionId: 'session-copy', sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '助手回复内容', metadata: {}, createdAt: new Date(0).toISOString() }],
        employees: [employee],
        draft: '',
        onDraftChange: vi.fn(),
        onSend: vi.fn(async () => undefined),
        onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
        onOpenDossier: vi.fn(),
        onOpenArtifact: vi.fn(),
        onRecruit: vi.fn(),
      })) })

      const message = host.querySelector<HTMLElement>('.message')
      expect(message).toBeDefined()
      await act(async () => { message?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })) })
      const copyItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent?.includes('复制回复'))
      expect(copyItem).toBeDefined()
      await act(async () => { copyItem?.click() })
      expect(writeText).toHaveBeenCalledWith('助手回复内容')
    } finally {
      await act(async () => { root.unmount() })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
    }
  })
})
