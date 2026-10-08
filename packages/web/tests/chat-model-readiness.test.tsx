import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationModelReadiness } from '@dsh-cyber/contracts'
import { setUiLocale } from '../src/i18n/runtime.js'
import { ChatModelReadiness } from '../src/features/chat-model-setup/ChatModelReadiness.js'
import { useModelReadiness } from '../src/features/chat-model-setup/use-model-readiness.js'
import { readConversationModelReadiness } from '../src/features/chat-model-setup/readiness.js'
vi.mock('../src/features/chat-model-setup/readiness.js', () => ({ readConversationModelReadiness: vi.fn() }))
const read = vi.mocked(readConversationModelReadiness)
const configured: ConversationModelReadiness = { worldId: 'world-b', canSend: true, items: [{ employeeId: 'role-b', state: 'configured-unverified', source: 'world', credentialSource: 'not-required', displayName: 'Local model', modelId: 'local' }] }
const missing: ConversationModelReadiness = { worldId: 'world-a', canSend: false, items: [{ employeeId: 'role-a', state: 'none', source: 'harness-default', credentialSource: 'none', blockingReason: 'no-model' }] }
beforeEach(() => setUiLocale('zh-CN'))
afterEach(() => { vi.clearAllMocks(); document.body.replaceChildren() })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function Probe({ worldId, employeeId, revision = 0 }: { worldId: string; employeeId: string; revision?: number }) {
  const state = useModelReadiness({ worldId, employeeIds: [employeeId], modelProfileId: undefined, revision, enabled: true })
  return <output>{state?.failed ? 'unavailable' : state?.readiness ? JSON.stringify(state.readiness) : 'loading'}</output>
}

describe('chat model readiness', () => {
  it('explains missing setup once and keeps model discovery separate from verification', () => {
    const none = renderToStaticMarkup(createElement(ChatModelReadiness, { readiness: missing, employeeNames: new Map(), onOpen() {} }))
    expect(none.match(/先连接一个模型/g)).toHaveLength(1)
    expect(none).toContain('配置对话模型')
    const saved = renderToStaticMarkup(createElement(ChatModelReadiness, { readiness: configured, employeeNames: new Map(), onOpen() {} }))
    expect(saved).toContain('已配置 · 对话连接未验证')
    expect(saved).toContain('继承世界')
    expect(saved).toContain('Local model')
    expect(saved).not.toContain('连接成功')
  })
  it('shows model and inheritance in the persistent entry after a conversation has messages', () => {
    const html = renderToStaticMarkup(createElement(ChatModelReadiness, { readiness: configured, compact: true, employeeNames: new Map(), onOpen() {} }))
    expect(html).toContain('更换或检查模型')
    expect(html).toContain('Local model · 继承世界')
  })
  it('does not display missing configuration for an externally managed runtime', () => {
    const readiness: ConversationModelReadiness = { worldId: 'a', canSend: true, items: [{ employeeId: 'r', source: 'external-runtime', state: 'configured-unverified', credentialSource: 'external-runtime' }] }
    const html = renderToStaticMarkup(createElement(ChatModelReadiness, { readiness, employeeNames: new Map(), onOpen() {} }))
    expect(html).toContain('宿主运行时')
    expect(html).not.toContain('先连接一个模型')
  })
  it('rejects late results after switching owners and aborts their fetch', async () => {
    const first = deferred<ConversationModelReadiness>(); const second = deferred<ConversationModelReadiness>()
    read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
    await act(async () => root.render(<Probe worldId="world-a" employeeId="role-a" />))
    const signal = read.mock.calls[0]![3]!
    await act(async () => root.render(<Probe worldId="world-b" employeeId="role-b" />))
    expect(signal.aborted).toBe(true)
    await act(async () => { second.resolve(configured); await second.promise })
    expect(host.textContent).toContain('Local model')
    await act(async () => { first.resolve(missing); await first.promise })
    expect(host.textContent).toContain('world-b')
    expect(host.textContent).not.toContain('no-model')
    await act(async () => root.unmount())
  })
  it('marks a failed check unknown, then refreshes after configuration changes without a model call', async () => {
    read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(configured)
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
    await act(async () => root.render(<Probe worldId="world-b" employeeId="role-b" />))
    expect(host.textContent).toBe('unavailable')
    await act(async () => root.render(<Probe worldId="world-b" employeeId="role-b" revision={1} />))
    expect(host.textContent).toContain('configured-unverified')
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })
})
