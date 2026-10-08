import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment, WorldSettings } from '@dsh-cyber/contracts'
import App from '../src/App.js'
import type { PendingChatTurn } from '../src/chat-realtime.js'
import { composerDraftOwnerKey, composerDraftStore } from '../src/composer-draft-store.js'
import { chatSubmissionStore } from '../src/chat-submission-store.js'
import { demoData } from '../src/demo-data.js'
import '../src/i18n/messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

// Only unrelated visual/runtime surfaces are replaced. App, its live-startup
// effects, API error handling, ChatWorkbench, queue menu and composer are real.
vi.mock('../src/world-live-client.js', () => ({ subscribeWorldLive: () => () => undefined }))
vi.mock('../src/components/WorldSideDock.js', () => ({ WorldSideDock: () => null }))
vi.mock('../src/components/CreativeWorkshopLauncher.js', () => ({ CreativeWorkshopLauncher: () => null }))
vi.mock('../src/features/model-hub/ModelHubLauncher.js', () => ({ ModelHubLauncher: () => null }))
vi.mock('../src/features/connection-hub/ConnectionHubLauncher.js', () => ({ ConnectionHubLauncher: () => null }))
vi.mock('../src/features/skill-center/SkillCenterLauncher.js', () => ({ SkillCenterLauncher: () => null }))
vi.mock('../src/features/voice/VoiceConversationControl.js', () => ({ VoiceConversationControl: () => null }))
vi.mock('../src/features/voice/ComposerReplySpeaker.js', () => ({ ComposerReplySpeaker: () => null }))

const world = demoData.activeWorld
const session = demoData.sessions[0]!
const ownerKey = composerDraftOwnerKey(world.id, `session:${session.id}`)
const attachment: ChatAttachment = {
  assetId: 'queued-edit-attachment', name: '排队需求.md', mimeType: 'text/markdown',
  byteLength: 42, url: '/api/assets/queued-edit-attachment',
}
const queued: PendingChatTurn = {
  id: 'queued-edit-client', serverQueueId: 'queued-edit-server', worldId: world.id,
  sessionId: session.id, queueKey: `session:${session.id}`, employeeIds: [demoData.employees[0]!.id],
  title: '排队请求', content: '请检查排队消息的完整内容\n第二行也必须保留。',
  attachments: [attachment], modelProfileId: 'queued-original-model', reasoningEffort: 'high',
  status: 'queued', createdAt: '2026-10-08T09:00:00.000Z',
}
const settings: WorldSettings = {
  schemaVersion: 1, worldId: world.id, lore: '', scenario: '',
  userIdentity: { displayName: '用户', worldRole: 'owner', addressAs: '你' },
  terminology: { characterSingular: '角色', characterPlural: '角色', addCharacterVerb: '添加', groupConversation: '群聊', assignment: '任务' },
  appearance: {
    accentColor: '#fff', pageBackground: '#111', panelBackground: '#222', ownerBubbleColor: '#333',
    characterBubbleColor: '#444', textColor: '#fff', mutedTextColor: '#ddd',
    panelRadius: 12, bubbleRadius: 12, buttonRadius: 8, fontScale: 1,
  },
  model: { reasoningEffort: 'auto', responseLanguage: 'zh-CN' },
  runtime: { permissionMode: 'read-only' }, updatedAt: queued.createdAt,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})

let host: HTMLDivElement
let root: Root
let startup: ReturnType<typeof deferred<Response>>
let cancellation: ReturnType<typeof deferred<Response>>
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let queueItems: PendingChatTurn[]
let delayedQueueRead: ReturnType<typeof deferred<Response>> | undefined
let unexpectedRequests: string[]
let rejectNextChat: boolean

beforeEach(() => {
  // No ?demo: the first render must have no activeWorld/composer owner, exactly
  // the production cold-start state that made the old stable callback stale.
  expect(new URLSearchParams(window.location.search).has('demo')).toBe(false)
  localStorage.clear()
  sessionStorage.clear()
  composerDraftStore.clearWorld(world.id)
  setUiLocale('zh-CN')
  startup = deferred<Response>()
  cancellation = deferred<Response>()
  queueItems = [{ ...queued }]
  delayedQueueRead = undefined
  unexpectedRequests = []
  rejectNextChat = false
  for (const item of chatSubmissionStore.getSnapshot()) chatSubmissionStore.remove(item.id)
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input)
    if (init?.method === 'DELETE' && path === `/api/worlds/${world.id}/chat-queue/${queued.serverQueueId}`) {
      const response = await cancellation.promise
      if (response.ok) queueItems = []
      return response
    }
    if (path === '/api/workspaces') return startup.promise
    if (path === `/api/workspaces/${demoData.workspace.id}/snapshot`) return json({ worlds: [world] })
    if (path.endsWith('/preferences')) return json({ preferences: demoData.preferences })
    if (path.endsWith('/model-profiles')) return json({ items: demoData.modelProfiles, assignments: [] })
    if (path.endsWith('/packages')) return json({ items: [], transactions: [] })
    if (path.endsWith('/skins') || path.endsWith('/plugins')) return json({ items: [] })
    if (path === `/api/worlds/${world.id}/snapshot`) return json({
      employees: demoData.employees, dossiers: Object.values(demoData.dossiers), openSessions: demoData.sessions,
      authorities: [], sessionParticipants: demoData.sessions.map((item) => ({
        sessionId: item.id, kind: 'employee', participantId: demoData.employees[0]!.id,
      })),
    })
    if (path.endsWith('/runtime-capability')) return json({ supported: false })
    if (path.endsWith('/settings')) return json({ settings, access: { worldId: world.id, passwordEnabled: false, unlocked: true } })
    if (path.endsWith('/schedules') || path.endsWith('/runtime-access-grants')) return json({ items: [] })
    if (path.endsWith('/pending-decisions')) return json({ approvals: [], permissionRequests: [] })
    if (path === `/api/worlds/${world.id}/chat` && init?.method === 'POST') {
      if (rejectNextChat) {
        rejectNextChat = false
        return json({ error: { code: 'prompt_rejected', message: '请修改后重新发送' } }, 422)
      }
      return json({ session, queueItem: { status: 'completed' } })
    }
    if (path.endsWith('/chat-queue')) return delayedQueueRead?.promise ?? json({ items: queueItems })
    if (path.includes('/messages?')) return json({ items: [], hasMore: false })
    if (path.endsWith('/conversation-hub')) return json({ items: demoData.sessions.map((item) => ({
      session: item, participantIds: [demoData.employees[0]!.id], pinned: false, hidden: false,
    })) })
    unexpectedRequests.push(`${init?.method ?? 'GET'} ${path}`)
    throw new Error(`Unexpected App request: ${init?.method ?? 'GET'} ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  composerDraftStore.clearWorld(world.id)
  vi.unstubAllGlobals()
  expect(unexpectedRequests).toEqual([])
})

async function startApp() {
  await act(async () => root.render(<App />))
  expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.anything())
  expect(host.querySelector('textarea')).toBeNull()
  await act(async () => startup.resolve(json({ items: [demoData.workspace] })))
  expect(host.querySelector('.error-banner')).toBeNull()
  expect(composer().disabled).toBe(false)
  expect(composer().value).toBe('')
  expect(queueButton()).toBeDefined()
}

function composer() {
  const input = host.querySelector<HTMLTextAreaElement>('.composer textarea')
  expect(input).not.toBeNull()
  return input!
}

function queueButton() {
  const button = host.querySelector<HTMLButtonElement>('.chat-queue button[aria-haspopup="menu"]')
  expect(button).not.toBeNull()
  expect(button!.hidden).toBe(false)
  expect(button!.disabled).toBe(false)
  return button!
}

async function editFromVisibleMenu() {
  await act(async () => queueButton().click())
  const menu = document.querySelector('[role="menu"][aria-label="排队消息操作"]')
  expect(menu).not.toBeNull()
  const edit = [...menu!.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
    .find((button) => button.textContent === '编辑排队消息')
  expect(edit).toBeDefined()
  expect(edit!.hidden).toBe(false)
  expect(edit!.disabled).toBe(false)
  await act(async () => edit!.click())
}

function cancellationCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
}

async function typeDraft(value: string, expectedOwner = ownerKey) {
  await act(async () => {
    const input = composer()
    // Use the native value setter so React sees a genuine DOM input event.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(composer().value).toBe(value)
  expect(composerDraftStore.get(expectedOwner).text).toBe(value)
}

function expectRestoredOriginal() {
  expect(composer().value).toBe(queued.content)
  expect(host.querySelector('[aria-label="待发送附件"]')?.textContent).toContain(attachment.name)
  expect(composerDraftStore.get(ownerKey)).toMatchObject({
    text: queued.content, attachments: [{ status: 'ready', attachment }],
    modelProfileId: queued.modelProfileId, reasoningEffort: queued.reasoningEffort,
  })
  expect(host.querySelector('.chat-queue')).toBeNull()
}

describe('queued-message editing through the cold-start App', () => {
  it('restores the original text, attachment and settings only after a successful DELETE', async () => {
    await startApp()
    await editFromVisibleMenu()
    expect(cancellationCalls()).toEqual([[`/api/worlds/${world.id}/chat-queue/${queued.serverQueueId}`, expect.objectContaining({ method: 'DELETE' })]])
    expect(composer().value).toBe('')
    expect(host.querySelector('[aria-label="待发送附件"]')).toBeNull()
    expect(host.querySelector('.chat-queue')).not.toBeNull()

    await act(async () => cancellation.resolve(json({ cancelled: true })))
    expectRestoredOriginal()
    expect(document.activeElement).toBe(composer())
  })

  it.each(['conflict', 'network'] as const)('keeps the queued message and draft intact on %s failure', async (failure) => {
    await startApp()
    const originalDraft = composerDraftStore.get(ownerKey)
    await editFromVisibleMenu()
    await act(async () => {
      if (failure === 'conflict') cancellation.resolve(json({ error: { code: 'queue_item_not_queued', message: '消息已开始执行，无法撤回' } }, 409))
      else cancellation.reject(new Error('网络连接中断'))
    })
    expect(composerDraftStore.get(ownerKey)).toBe(originalDraft)
    expect(composer().value).toBe('')
    expect(host.querySelector('[aria-label="待发送附件"]')).toBeNull()
    expect(host.querySelector('.chat-queue')?.textContent).toContain(queued.content)
    expect(host.querySelector('.error-banner')?.textContent).toContain(failure === 'conflict' ? '消息已开始执行，无法撤回' : '网络连接中断')
    expect(cancellationCalls()).toHaveLength(1)
  })


  it('does not cancel a queued message when the composer already contains a draft', async () => {
    await startApp()
    await typeDraft('需要保留的当前草稿')
    const originalDraft = composerDraftStore.get(ownerKey)
    await editFromVisibleMenu()
    expect(cancellationCalls()).toHaveLength(0)
    expect(composerDraftStore.get(ownerKey)).toBe(originalDraft)
    expect(composer().value).toBe('需要保留的当前草稿')
    expect(host.querySelector('.chat-queue')?.textContent).toContain(queued.content)
    expect(host.querySelector('.error-banner')?.textContent).toContain('请先发送或清空当前草稿')
  })

  it('sends only one DELETE when the visible edit action is repeated before completion', async () => {
    await startApp()
    await editFromVisibleMenu()
    await editFromVisibleMenu()
    expect(cancellationCalls()).toHaveLength(1)
    await act(async () => cancellation.resolve(json({ cancelled: true })))
    expectRestoredOriginal()
    expect(composerDraftStore.get(ownerKey).recalledMessage).toBeUndefined()
  })


  it('resubmits the recovered attachment, model and reasoning through the real Send control', async () => {
    await startApp()
    await editFromVisibleMenu()
    await act(async () => cancellation.resolve(json({ cancelled: true })))
    expectRestoredOriginal()
    const send = host.querySelector<HTMLButtonElement>('button.send-button')!
    expect(send.disabled).toBe(false)
    await act(async () => send.click())
    const requests = fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith('/chat') && init?.method === 'POST')
    expect(requests).toHaveLength(1)
    expect(JSON.parse(requests[0]![1]!.body as string)).toMatchObject({
      prompt: queued.content, attachments: [attachment], sessionId: session.id,
      modelProfileId: queued.modelProfileId, reasoningEffort: queued.reasoningEffort,
    })
    expect(composer().value).toBe('')
    expect(host.querySelector('[aria-label="待发送附件"]')).toBeNull()
  })


  it('keeps the recalled model and reasoning through a rejected send and visible Restore', async () => {
    await startApp()
    await editFromVisibleMenu()
    await act(async () => cancellation.resolve(json({ cancelled: true })))
    rejectNextChat = true
    await act(async () => host.querySelector<HTMLButtonElement>('button.send-button')!.click())
    expect(composer().value).toBe('')
    const restore = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '恢复到输入框')
    expect(restore).toBeDefined()
    expect(restore!.disabled).toBe(false)
    await act(async () => restore!.click())
    expectRestoredOriginal()
    await act(async () => host.querySelector<HTMLButtonElement>('button.send-button')!.click())
    const bodies = fetchMock.mock.calls
      .filter(([path, init]) => String(path).endsWith('/chat') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(init!.body as string))
    expect(bodies).toHaveLength(2)
    for (const body of bodies) expect(body).toMatchObject({
      prompt: queued.content, attachments: [attachment], modelProfileId: queued.modelProfileId,
      reasoningEffort: queued.reasoningEffort, sessionId: session.id,
    })
  })

  it('does not resurrect an edited turn when an older queue refresh arrives after DELETE', async () => {
    await startApp()
    // Sending another message starts the normal receipt-driven queue refresh.
    // Hold its pre-cancellation snapshot while editing the original queue row.
    delayedQueueRead = deferred<Response>()
    await typeDraft('另一条已完成的消息')
    await act(async () => host.querySelector<HTMLButtonElement>('button.send-button')!.click())
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/chat-queue'))).toHaveLength(2)
    expect(composer().value).toBe('')
    await editFromVisibleMenu()
    await act(async () => cancellation.resolve(json({ cancelled: true })))
    expectRestoredOriginal()
    await act(async () => delayedQueueRead!.resolve(json({ items: [queued] })))
    expectRestoredOriginal()
    expect(cancellationCalls()).toHaveLength(1)
  })

  it('restores into the original owner after navigating to another real conversation', async () => {
    await startApp()
    await editFromVisibleMenu()
    const otherSession = demoData.sessions[1]!
    const otherOwner = composerDraftOwnerKey(world.id, `session:${otherSession.id}`)
    const selectSession = async (title: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button.session-row')]
        .find((item) => item.getAttribute('aria-label') === title)
      expect(button).toBeDefined()
      expect(button!.disabled).toBe(false)
      await act(async () => button!.click())
    }
    await selectSession(otherSession.title)
    await typeDraft('另一会话的新草稿', otherOwner)
    await act(async () => cancellation.resolve(json({ cancelled: true })))
    expect(composer().value).toBe('另一会话的新草稿')
    expect(host.querySelector('[aria-label="待发送附件"]')).toBeNull()
    expect(composerDraftStore.get(ownerKey).text).toBe(queued.content)
    await selectSession(session.title)
    expectRestoredOriginal()
    expect(composerDraftStore.get(otherOwner).text).toBe('另一会话的新草稿')
  })

  it('preserves newer typing and recovers the cancelled content through the visible recovery action', async () => {
    await startApp()
    await editFromVisibleMenu()
    await typeDraft('取消期间刚写的新草稿')
    await act(async () => cancellation.resolve(json({ cancelled: true })))
    expect(composer().value).toBe('取消期间刚写的新草稿')
    expect(composerDraftStore.get(ownerKey).recalledMessage).toMatchObject({ text: queued.content, attachments: [{ attachment }] })
    const recover = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '恢复撤回消息')
    expect(recover).toBeDefined()
    expect(recover!.disabled).toBe(true)
    await typeDraft('')
    expect(recover!.disabled).toBe(false)
    await act(async () => recover!.click())
    expectRestoredOriginal()
    expect(host.querySelector('[aria-label="已撤回的排队消息"]')).toBeNull()
  })
})
