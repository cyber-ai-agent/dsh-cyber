import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'
import { canSaveReplyAsDocument, ChatWorkbench } from '../src/components/ChatWorkbench.js'
import type { CyberEmployee } from '../src/types.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

const employee = { id: 'employee-save', displayName: '文书角色', role: '记录', avatarIndex: 0, currentActivity: '正在工作' } as CyberEmployee
const world = { id: 'world-save', workspaceId: 'workspace-save', name: '保存测试世界', templateId: 'personal-world', status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as World
const session = { id: 'session-save', workspaceId: world.workspaceId, worldId: world.id, kind: 'direct', title: employee.displayName, status: 'open', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as WorkSession

function message(overrides: Partial<WorkMessage>): WorkMessage {
  return {
    id: 'assistant-save',
    sessionId: session.id,
    sequence: 1,
    senderId: employee.id,
    senderKind: 'employee',
    kind: 'assistant',
    content: '# 会议纪要\n\n下周一复盘。',
    metadata: {},
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

describe('saving a reply as a document from the conversation', () => {
  it('offers the action only on a character reply that actually has text', () => {
    expect(canSaveReplyAsDocument(message({}))).toBe(true)
    expect(canSaveReplyAsDocument(message({ content: '   \n ' }))).toBe(false)
    expect(canSaveReplyAsDocument(message({ senderId: 'owner', senderKind: 'owner', kind: 'user', content: '帮我写一份周报' }))).toBe(false)
    expect(canSaveReplyAsDocument(message({ senderKind: 'system', kind: 'system', content: '角色已加入会话' }))).toBe(false)
    expect(canSaveReplyAsDocument(message({ metadata: { streaming: true }, content: '正在回复' }))).toBe(false)
  })

  it('saves the reply through the world artifact path and reports it as kept, not executed', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ artifact: { id: 'artifact-save', title: '会议纪要' }, version: { version: 1 }, created: true }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const host = await render(message({}))

    const row = host.querySelector<HTMLElement>('.message')
    await act(async () => { row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })) })
    const item = menuItem('将回复保存为文档')
    expect(item).toBeDefined()
    await act(async () => { item?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/worlds/${encodeURIComponent(world.id)}/artifacts/save-reply`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body)) as Record<string, unknown>).toEqual({ messageId: 'assistant-save' })
    expect(host.textContent).toContain('已保存为文档')
    // The row must not start claiming a run produced a file.
    expect(host.textContent).not.toContain('产物可用')
  })

  it('hides the action on the owner row and on a streaming reply', async () => {
    const host = await render(message({ id: 'owner-row', senderId: 'owner', senderKind: 'owner', kind: 'user', content: '帮我整理一下' }))
    const row = host.querySelector<HTMLElement>('.message')
    await act(async () => { row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })) })
    expect(menuItem('将回复保存为文档')).toBeUndefined()
  })

  it('reports the server refusal instead of pretending the document exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'artifact_reply_world_mismatch', message: '这条回复不属于当前世界' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )))
    const host = await render(message({}))
    const row = host.querySelector<HTMLElement>('.message')
    await act(async () => { row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })) })
    await act(async () => { menuItem('将回复保存为文档')?.click(); await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(host.textContent).toContain('这条回复不属于当前世界')
    expect(host.textContent).not.toContain('已保存为文档')
  })
})

function menuItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent?.includes(label))
}

async function render(item: WorkMessage): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ChatWorkbench, {
      demoMode: false,
      world,
      session,
      messages: [item],
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
  return host
}
