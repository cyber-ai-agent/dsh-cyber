import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'
import { ChatWorkbench } from '../src/components/ChatWorkbench.js'
import type { CyberEmployee } from '../src/types.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('Chat control UI', () => {
  it('uploads an image pasted into the composer and shows it as an attachment', async () => {
    const employee = { id: 'employee-paste', displayName: '粘贴角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-paste', workspaceId: 'workspace-paste', name: '粘贴测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onUploadAttachment = vi.fn(async (file: File) => ({ assetId: 'pasted-image', name: file.name, mimeType: 'image/png' as const, byteLength: file.size, url: '/api/assets/pasted-image' }))
    await act(async () => { root.render(createElement(ChatWorkbench, {
      demoMode: true,
      world,
      participantIds: [employee.id],
      messages: [],
      employees: [employee],
      draft: '',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment,
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
    })) })

    const image = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }] } })
    await act(async () => {
      host.querySelector<HTMLTextAreaElement>('textarea')?.dispatchEvent(paste)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(paste.defaultPrevented).toBe(true)
    expect(onUploadAttachment).toHaveBeenCalledOnce()
    expect(onUploadAttachment.mock.calls[0]?.[0].name).toMatch(/^粘贴图片-/u)
    expect(host.textContent).toContain('粘贴图片-')
    expect(host.querySelector('img[alt$="预览"]')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('treats the first accepted message as current work, not an extra queued message', () => {
    const employee = { id: 'employee-one', displayName: '单条角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-one', workspaceId: 'workspace-one', name: '单条测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const html = renderToStaticMarkup(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      participantIds: [employee.id],
      messages: [],
      employees: [employee],
      pendingCount: 1,
      queuedCount: 0,
      queueItems: [{ id: 'only', queueKey: 'direct:employee-one', worldId: world.id, employeeIds: [employee.id], title: '当前消息', status: 'queued', createdAt: new Date().toISOString() }],
      draft: '',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
    }))
    expect(html).toContain('消息已接收，正在等待角色处理')
    expect(html).toContain('等待插入')
    expect(html).not.toContain('另有 1 条')
  })

  it('shows queued follow-ups above the composer and removes manual queue controls', () => {
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
        { id: 'queued', queueKey: 'direct:employee-a', worldId: world.id, employeeIds: [employee.id], title: '甲角色对话', content: '下一条消息', status: 'queued', createdAt: new Date().toISOString() },
      ],
      draft: '继续补充条件',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
      onStopTurn: vi.fn(async () => undefined),
      onCancelQueuedTurn: vi.fn(async () => undefined),
    }))
    expect(html).toContain('正在回复中')
    expect(html).toContain('插入对话')
    expect(html).toContain('下一条消息')
    expect(html).not.toContain('send-button--stop')
    expect(html).toContain('撤销')
    expect(html).not.toContain('排队发送')
    expect(html).not.toContain('队列操作')
    expect(html).not.toContain('插入队列前方')
    expect(html).not.toContain('下一条执行')
    expect(html).not.toContain('打开命令选择器')
  })

  it('automatically inserts a typed follow-up after the active turn', async () => {
    const employee = { id: 'employee-insert', displayName: '插入角色', role: '分析', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
    const world = { id: 'world-insert', workspaceId: 'workspace-insert', name: '插入测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onSend = vi.fn(async () => undefined)
    await act(async () => { root.render(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      participantIds: [employee.id],
      messages: [],
      employees: [employee],
      pendingCount: 1,
      queueItems: [{ id: 'running', queueKey: 'direct:employee-insert', worldId: world.id, employeeIds: [employee.id], title: '当前工作', status: 'running', createdAt: new Date().toISOString(), workTurnId: 'turn-running' }],
      draft: '补充验收条件',
      onDraftChange: vi.fn(),
      onSend,
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
      onStopTurn: vi.fn(async () => undefined),
    })) })

    const sendButton = host.querySelector<HTMLButtonElement>('.send-button')
    expect(sendButton?.getAttribute('aria-label')).toBe('插入对话')
    await act(async () => { sendButton?.click() })
    expect(onSend).toHaveBeenCalledWith('补充验收条件', [], 'next')
    await act(async () => { root.unmount() })
  })

  it('stops following streamed output after the reader scrolls upward', async () => {
    const now = new Date(0).toISOString()
    const employee = { id: 'employee-scroll', displayName: '滚动角色', role: '分析', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
    const world = { id: 'world-scroll', workspaceId: 'workspace-scroll', name: '滚动测试世界', templateId: 'personal-world', status: 'active', createdAt: now, updatedAt: now } as World
    const session = { id: 'session-scroll', workspaceId: world.workspaceId, worldId: world.id, kind: 'direct', title: '滚动角色', status: 'open', createdAt: now, updatedAt: now } as WorkSession
    const first = { id: 'message-first', sessionId: session.id, sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '第一条回复', metadata: {}, createdAt: now } as WorkMessage
    const second = { ...first, id: 'message-second', sequence: 2, content: '继续生成的内容', metadata: { streaming: true } } as WorkMessage
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const common = {
      demoMode: false,
      world,
      session,
      participantIds: [employee.id],
      employees: [employee],
      draft: '',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
    }
    await act(async () => {
      root.render(createElement(ChatWorkbench, { ...common, messages: [first] }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    const scroll = host.querySelector<HTMLDivElement>('.message-scroll')!
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 })
    scroll.scrollTop = 120
    const scrollTo = vi.fn()
    Object.defineProperty(scroll, 'scrollTo', { configurable: true, value: scrollTo })
    await act(async () => { scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(host.textContent).toContain('回到最新消息')

    await act(async () => {
      root.render(createElement(ChatWorkbench, { ...common, messages: [first, second], pendingCount: 1, sending: true }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scroll.scrollTop).toBe(120)
    await act(async () => { root.unmount() })
  })

  it('executes the topic command locally and keeps the transcript intact', async () => {
    const employee = { id: 'employee-topic', displayName: '话题角色', role: '分析', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
    const world = { id: 'world-topic', workspaceId: 'workspace-topic', name: '话题测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onSend = vi.fn(async () => undefined)
    const onDraftChange = vi.fn()
    await act(async () => { root.render(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      participantIds: [employee.id],
      messages: [],
      employees: [employee],
      draft: '/换个话题',
      onDraftChange,
      onSend,
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
    })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.send-button')?.click() })
    expect(onSend).not.toHaveBeenCalled()
    expect(onDraftChange).toHaveBeenCalledWith('')
    expect(host.textContent).toContain('已开启新话题，之前的对话记录已保留')
    await act(async () => { root.unmount() })
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
      await act(async () => {
        root.render(createElement(ChatWorkbench, {
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
        }))
        // Keep the act scope open until ChatWorkbench's lazy Markdown module
        // has resolved so Suspense does not ping the root after the test exits.
        await import('../src/components/MarkdownMessage.js')
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

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

  it('reports a message as submitted for consolidation instead of claiming durable knowledge', async () => {
    const employee = { id: 'employee-knowledge', displayName: '知识角色', role: '分析', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
    const world = { id: 'world-knowledge', workspaceId: 'workspace-knowledge', name: '知识测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const session = { id: 'session-knowledge', workspaceId: world.workspaceId, worldId: world.id, kind: 'direct', title: employee.displayName, status: 'open', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as WorkSession
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ job: { id: 'job-knowledge', status: 'queued' } }), { status: 202, headers: { 'content-type': 'application/json' } })))
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(ChatWorkbench, {
        demoMode: false,
        world,
        session,
        messages: [{ id: 'assistant-knowledge', sessionId: session.id, sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '可整理的事实', metadata: {}, createdAt: new Date(0).toISOString() }],
        employees: [employee],
        draft: '',
        onDraftChange: vi.fn(),
        onSend: vi.fn(async () => undefined),
        onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
        onOpenDossier: vi.fn(),
        onOpenArtifact: vi.fn(),
        onRecruit: vi.fn(),
      }))
      await import('../src/components/MarkdownMessage.js')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const message = host.querySelector<HTMLElement>('.message')
    await act(async () => { message?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })) })
    const item = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((candidate) => candidate.textContent?.includes('加入长期知识'))
    await act(async () => { item?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('已提交整理')
    expect(host.textContent).not.toContain('已加入长期知识')
    await act(async () => { root.unmount() })
  })

  it('shows completion outbox progress and a retry action without changing the main answer', () => {
    const employee = { id: 'employee-completion', displayName: '交付角色', role: '分析', avatarIndex: 0, currentActivity: '可接任务' } as CyberEmployee
    const world = { id: 'world-completion', workspaceId: 'workspace-completion', name: '交付测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const common = {
      demoMode: false,
      world,
      employees: [employee],
      draft: '',
      onDraftChange: vi.fn(),
      onSend: vi.fn(async () => undefined),
      onUploadAttachment: vi.fn(async () => { throw new Error('not used') }),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
    }
    const pending = renderToStaticMarkup(createElement(ChatWorkbench, {
      ...common,
      messages: [{ id: 'pending', sessionId: 'session', sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '主回答可见', metadata: { completionJobId: 'job-pending', completionStatus: 'pending' }, createdAt: new Date(0).toISOString() }],
    }))
    expect(pending).toContain('主回答可见')
    expect(pending).toContain('正在检查本轮产物')

    const failed = renderToStaticMarkup(createElement(ChatWorkbench, {
      ...common,
      messages: [{ id: 'failed', sessionId: 'session', sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '主回答仍然成功', metadata: { completionJobId: 'job-failed', completionStatus: 'failed' }, createdAt: new Date(0).toISOString() }],
      onRetryCompletionJob: vi.fn(async () => undefined),
    }))
    expect(failed).toContain('主回答仍然成功')
    expect(failed).toContain('产物整理失败')
    expect(failed).toContain('重试')

    const completedWithoutFacts = renderToStaticMarkup(createElement(ChatWorkbench, {
      ...common,
      messages: [{ id: 'completed-empty', sessionId: 'session', sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '主回答完成，但没有登记文件', metadata: { completionJobId: 'job-empty', completionStatus: 'completed', completionOutcome: 'no-artifact', artifactCount: 0 }, createdAt: new Date(0).toISOString() }],
    }))
    expect(completedWithoutFacts).not.toContain('产物可用')

    const completedWithFacts = renderToStaticMarkup(createElement(ChatWorkbench, {
      ...common,
      messages: [{ id: 'completed-artifact', sessionId: 'session', sequence: 1, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '真实产物已登记', metadata: { completionJobId: 'job-artifact', completionStatus: 'completed', artifactRefs: ['artifact-1'], artifactCount: 1 }, createdAt: new Date(0).toISOString() }],
    }))
    expect(completedWithFacts).toContain('产物可用')
  })
})
