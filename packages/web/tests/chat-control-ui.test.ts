import { createElement, useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'
import { ChatWorkbench } from '../src/components/ChatWorkbench.js'
import type { ComposerAttachmentDraft } from '../src/composer-draft-store.js'
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

  it('keeps successful files visible when a later file in the batch fails', async () => {
    const employee = { id: 'employee-partial', displayName: '部分角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-partial', workspaceId: 'workspace-partial', name: '部分上传世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onUploadAttachment = vi.fn(async (file: File) => {
      if (file.name === 'bad.txt') throw new Error('文件内容无效')
      return { assetId: 'good-asset', name: file.name, mimeType: 'text/plain' as const, byteLength: file.size, url: '/api/worlds/world-partial/assets/good-asset' }
    })
    await act(async () => { root.render(createElement(ChatWorkbench, {
      demoMode: true,
      world,
      composerOwnerKey: '["world-partial","conversation-partial"]',
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

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    const good = new File(['ok'], 'good.txt', { type: 'text/plain' })
    const bad = new File(['bad'], 'bad.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { configurable: true, value: [good, bad] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(onUploadAttachment).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.composer-attachment--ready')).not.toBeNull()
    expect(host.querySelector('.composer-attachment--failed')).not.toBeNull()
    expect(host.textContent).toContain('文件内容无效')
    await act(async () => { root.unmount() })
  })

  it('cancels the remaining batch when a pending attachment is removed', async () => {
    const employee = { id: 'employee-cancel-upload', displayName: '取消角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-cancel-upload', workspaceId: 'workspace-cancel-upload', name: '取消上传世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let releaseFirst!: () => void
    let firstStartedResolve!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve
    })
    let calls = 0
    const onUploadAttachment = vi.fn(async (file: File) => {
      calls += 1
      if (calls === 1) {
        firstStartedResolve()
        await new Promise<void>((resolve) => { releaseFirst = resolve })
      }
      return { assetId: file.name, name: file.name, mimeType: 'text/plain' as const, byteLength: file.size, url: `/api/worlds/${world.id}/assets/${file.name}` }
    })
    await act(async () => { root.render(createElement(ChatWorkbench, {
      demoMode: true,
      world,
      composerOwnerKey: '["world-cancel-upload","conversation-cancel-upload"]',
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

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await firstStarted
    const remove = host.querySelector<HTMLButtonElement>('button[aria-label="移除附件 one.txt"]')!
    await act(async () => { remove.click() })
    expect(host.querySelector('.composer-attachments')).toBeNull()
    releaseFirst()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onUploadAttachment).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.composer-attachments')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('keeps concurrent uploads in separate owner generations', async () => {
    const employee = { id: 'employee-owner-upload', displayName: '归属角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-owner-upload', workspaceId: 'workspace-owner-upload', name: '归属上传世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const ownerA = '["world-owner-upload","conversation-a"]'
    const ownerB = '["world-owner-upload","conversation-b"]'
    let releaseA!: () => void
    let releaseB!: () => void
    let startedA!: () => void
    let startedB!: () => void
    const aStarted = new Promise<void>((resolve) => { startedA = resolve })
    const bStarted = new Promise<void>((resolve) => { startedB = resolve })
    const waitA = new Promise<void>((resolve) => { releaseA = resolve })
    const waitB = new Promise<void>((resolve) => { releaseB = resolve })
    const onUploadAttachment = vi.fn(async (file: File) => {
      if (file.name === 'owner-a.txt') {
        startedA()
        await waitA
      } else {
        startedB()
        await waitB
      }
      return { assetId: file.name, name: file.name, mimeType: 'text/plain' as const, byteLength: file.size, url: `/api/worlds/${world.id}/assets/${file.name}` }
    })
    function DraftHarness({ owner }: { owner: string }) {
      const [drafts, setDrafts] = useState<Record<string, ComposerAttachmentDraft[]>>({})
      return createElement(ChatWorkbench, {
        demoMode: true,
        world,
        composerOwnerKey: owner,
        attachments: drafts[owner] ?? [],
        onAttachmentsChange: (updater) => setDrafts((current) => ({ ...current, [owner]: updater(current[owner] ?? []) })),
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
      })
    }

    await act(async () => { root.render(createElement(DraftHarness, { owner: ownerA })) })
    const inputA = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(inputA, 'files', { configurable: true, value: [new File(['a'], 'owner-a.txt', { type: 'text/plain' })] })
    await act(async () => { inputA.dispatchEvent(new Event('change', { bubbles: true })) })
    await aStarted

    await act(async () => { root.render(createElement(DraftHarness, { owner: ownerB })) })
    const inputB = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(inputB, 'files', { configurable: true, value: [new File(['b'], 'owner-b.txt', { type: 'text/plain' })] })
    await act(async () => { inputB.dispatchEvent(new Event('change', { bubbles: true })) })
    await bStarted
    releaseB()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('owner-b.txt')
    expect(host.textContent).not.toContain('owner-a.txt')
    releaseA()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(onUploadAttachment).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('owner-a.txt')
    await act(async () => { root.render(createElement(DraftHarness, { owner: ownerA })) })
    expect(host.textContent).toContain('owner-a.txt')
    await act(async () => { root.unmount() })
  })

  it('marks an in-flight upload interrupted on unmount and restores the owner draft on remount', async () => {
    const employee = { id: 'employee-remount-upload', displayName: '恢复角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-remount-upload', workspaceId: 'workspace-remount-upload', name: '恢复上传世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const owner = '["world-remount-upload","conversation-remount-upload"]'
    let releaseUpload!: () => void
    let markUploadStarted!: () => void
    const uploadStarted = new Promise<void>((resolve) => { markUploadStarted = resolve })
    const uploadReleased = new Promise<void>((resolve) => { releaseUpload = resolve })
    let calls = 0
    const onUploadAttachment = vi.fn(async (file: File) => {
      calls += 1
      markUploadStarted()
      await uploadReleased
      return { assetId: 'remount-asset', name: file.name, mimeType: 'text/plain' as const, byteLength: file.size, url: `/api/worlds/${world.id}/assets/remount-asset` }
    })
    let latestDrafts: Record<string, ComposerAttachmentDraft[]> = {}
    function DraftHarness({ visible }: { visible: boolean }) {
      const [drafts, setDrafts] = useState<Record<string, ComposerAttachmentDraft[]>>({ [owner]: [{ id: 'existing', name: 'existing.txt', status: 'ready', attachment: { assetId: 'existing', name: 'existing.txt', mimeType: 'text/plain', byteLength: 8, url: `/api/worlds/${world.id}/assets/existing` } }] })
      latestDrafts = drafts
      if (!visible) return null
      return createElement(ChatWorkbench, {
        demoMode: true,
        world,
        composerOwnerKey: owner,
        attachments: drafts[owner] ?? [],
        onAttachmentsChange: (updater) => setDrafts((current) => {
          const next = { ...current, [owner]: updater(current[owner] ?? []) }
          latestDrafts = next
          return next
        }),
        participantIds: [employee.id],
        messages: [],
        employees: [employee],
        draft: '旧文本仍要保留',
        onDraftChange: vi.fn(),
        onSend: vi.fn(async () => undefined),
        onUploadAttachment,
        onOpenDossier: vi.fn(),
        onOpenArtifact: vi.fn(),
        onRecruit: vi.fn(),
      })
    }

    await act(async () => { root.render(createElement(DraftHarness, { visible: true })) })
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['pending'], 'pending.txt', { type: 'text/plain' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await uploadStarted
    await act(async () => { root.render(createElement(DraftHarness, { visible: false })) })
    releaseUpload()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(calls).toBe(1)
    expect(latestDrafts[owner]).toEqual([expect.objectContaining({ id: 'existing', status: 'ready' }), expect.objectContaining({ id: expect.any(String), status: 'interrupted' })])

    await act(async () => { root.render(createElement(DraftHarness, { visible: true })) })
    expect(host.textContent).toContain('旧文本仍要保留')
    expect(host.textContent).toContain('existing.txt')
    expect(host.textContent).toContain('上传已中断')
    await act(async () => { root.unmount() })
  })

  it('clears only the local draft when the clear-draft command is submitted', async () => {
    const employee = { id: 'employee-clear-draft', displayName: '清空角色', role: '分析', avatarIndex: 0, currentActivity: '等待处理' } as CyberEmployee
    const world = { id: 'world-clear-draft', workspaceId: 'workspace-clear-draft', name: '清空草稿世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onDraftChange = vi.fn()
    const onSend = vi.fn(async () => undefined)
    const common = {
      demoMode: true,
      world,
      composerOwnerKey: '["world-clear-draft","conversation-clear-draft"]',
      participantIds: [employee.id],
      messages: [],
      employees: [employee],
      onDraftChange,
      onSend,
      onUploadAttachment: vi.fn(async (file: File) => ({ assetId: 'clear-asset', name: file.name, mimeType: 'text/plain' as const, byteLength: file.size, url: '/api/worlds/world-clear-draft/assets/clear-asset' })),
      onOpenDossier: vi.fn(),
      onOpenArtifact: vi.fn(),
      onRecruit: vi.fn(),
    }
    await act(async () => { root.render(createElement(ChatWorkbench, { ...common, draft: '' })) })
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['keep until clear'], 'clear-me.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(host.textContent).toContain('clear-me.txt')

    await act(async () => { root.render(createElement(ChatWorkbench, { ...common, draft: '/清空草稿' })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.send-button')?.click() })
    expect(onSend).not.toHaveBeenCalled()
    expect(onDraftChange).toHaveBeenCalledWith('')
    expect(host.querySelector('.composer-attachments')).toBeNull()
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
    expect(host.textContent).toContain('已清空当前会话草稿，已发送消息和已上传资源仍保留')
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
