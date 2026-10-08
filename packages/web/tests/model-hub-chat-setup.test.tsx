import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelHubDialog, type ModelHubChatContext } from '../src/features/model-hub/ModelHubDialog.js'
import { setUiLocale } from '../src/i18n/runtime.js'
import * as api from '../src/features/model-hub/api.js'

vi.mock('../src/features/model-hub/api.js', () => ({
  addManualModel: vi.fn(), clearAssignment: vi.fn(), deleteProvider: vi.fn(), fetchBalance: vi.fn(),
  importModels: vi.fn(), listProfiles: vi.fn(), listProviders: vi.fn(), listWorldEmployees: vi.fn(),
  loadCatalog: vi.fn(), refreshCatalog: vi.fn(), removeProfile: vi.fn(), saveProvider: vi.fn(),
  setAssignment: vi.fn(), setProfileImageFlag: vi.fn(), syncProvider: vi.fn(), testProvider: vi.fn(),
}))

const provider: api.HubProvider = {
  id: 'provider-one', workspaceId: 'workspace-one', kind: 'local', name: '本地模型',
  baseUrl: 'http://127.0.0.1:8000/v1', api: 'openai-completions', providerKind: 'openai-compatible-local',
  modelCount: 2, credentialConfigured: false, assignedCount: 0, balanceSupported: false,
}
const makeProfile = (id: string, modelId: string, providerId = provider.id): api.HubProfile => ({
  id, modelId, providerId, workspaceId: 'workspace-one', displayName: `模型 ${modelId}`,
  baseUrl: provider.baseUrl, api: provider.api, isDefault: false, settings: {}, createdAt: '', updatedAt: '',
})
const profiles = [makeProfile('profile-one', 'one'), makeProfile('profile-two', 'two')]
const origin: ModelHubChatContext = { worldId: 'world-one', worldName: '原世界', employeeId: 'employee-one', employeeName: '原角色' }
let root: Root
let node: HTMLDivElement
let onClose: ReturnType<typeof vi.fn>
let onApplied: ReturnType<typeof vi.fn>
let mounted: boolean

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
async function render(chatContext: ModelHubChatContext | null = origin, workspaceId = 'workspace-one') {
  await act(async () => root.render(createElement(ModelHubDialog, {
    workspaceId, worlds: [], employees: [], ...(chatContext === null ? {} : { chatContext }), onClose, onApplied,
  })))
}
function button(label: string) {
  const result = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label)
  expect(result, `button ${label}`).toBeTruthy()
  return result!
}
async function click(label: string) { await act(async () => button(label).click()) }
async function selectProfile(id: string) {
  const radio = document.body.querySelector<HTMLInputElement>(`input[name="chat-setup-model"][value="${id}"]`)
  expect(radio).toBeTruthy()
  await act(async () => radio!.click())
}
async function openLocalProvider() {
  await click('添加服务商')
  const select = document.body.querySelector<HTMLSelectElement>('.model-hub__form select')!
  await act(async () => { select.value = 'local'; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function fetchModels() { await openLocalProvider(); await click('保存服务商并获取模型列表') }

beforeEach(() => {
  vi.resetAllMocks()
  setUiLocale('zh-CN')
  vi.mocked(api.loadCatalog).mockResolvedValue({ catalog: { schemaVersion: 1, version: 'test', providers: [] }, source: 'bundled', checkedAt: '' })
  vi.mocked(api.listProviders).mockResolvedValue([provider])
  vi.mocked(api.listProfiles).mockResolvedValue({ profiles, assignments: [] })
  vi.mocked(api.listWorldEmployees).mockResolvedValue([])
  vi.mocked(api.saveProvider).mockResolvedValue(provider)
  vi.mocked(api.testProvider).mockResolvedValue([{ id: 'one' }, { id: 'two' }])
  vi.mocked(api.importModels).mockResolvedValue({ created: 2, updated: 0 })
  vi.mocked(api.setAssignment).mockResolvedValue()
  onClose = vi.fn(); onApplied = vi.fn()
  node = document.createElement('div'); document.body.append(node); root = createRoot(node); mounted = true
})
afterEach(() => { if (mounted) act(() => root.unmount()); node.remove() })

describe('conversation model setup handoff', () => {
  it('focuses the dialog, wraps keyboard navigation, and restores its connected opener', async () => {
    const opener = document.createElement('button')
    document.body.append(opener); opener.focus()
    await render()
    expect(document.activeElement).toBe(button('关闭模型中心'))
    const controls = [...document.body.querySelectorAll<HTMLElement>('.model-hub button:not([disabled]), .model-hub input:not([disabled]), .model-hub textarea:not([disabled]), .model-hub select:not([disabled]), .model-hub [href], .model-hub [tabindex]:not([tabindex="-1"])')]
    const first = controls[0]!; const last = controls.at(-1)!
    last.focus()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })))
    expect(document.activeElement).toBe(first)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })))
    expect(document.activeElement).toBe(last)
    act(() => root.unmount()); mounted = false
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('preserves wizard Escape semantics and closes the hub with Escape after returning', async () => {
    await render(); await openLocalProvider()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })))
    expect(document.body.querySelector('.model-hub__wizard')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await click('取消并返回')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not restore focus to an opener removed while the dialog was open', async () => {
    const opener = document.createElement('button')
    const replacement = document.createElement('button')
    document.body.append(opener, replacement); opener.focus()
    await render()
    opener.remove(); replacement.focus()
    act(() => root.unmount()); mounted = false
    expect(document.activeElement).toBe(replacement)
    replacement.remove()
  })

  it('preserves the ordinary provider view when opened without a chat context', async () => {
    await render(null)
    expect(document.body.querySelector('.model-hub__chat-context')).toBeNull()
    expect(document.body.querySelector('.model-hub__provider-card')).not.toBeNull()
    expect(api.setAssignment).not.toHaveBeenCalled()
    expect(api.testProvider).not.toHaveBeenCalled()
  })

  it('requires an explicit model choice and applies only to the originating character', async () => {
    await render()
    expect(document.body.textContent).toContain('为角色「原角色」选择模型')
    expect(document.body.querySelector('input[name="chat-setup-model"]:checked')).toBeNull()
    expect(button('用于当前角色并返回对话').disabled).toBe(true)
    expect(api.testProvider).not.toHaveBeenCalled()
    await selectProfile('profile-two'); await click('用于当前角色并返回对话')
    expect(api.setAssignment).toHaveBeenCalledExactlyOnceWith('workspace-one', 'employee', 'employee-one', 'profile-two')
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the captured world, character and workspace when shell props change', async () => {
    await render()
    await render({ worldId: 'world-other', worldName: '其他世界', employeeId: 'employee-other', employeeName: '其他角色' }, 'workspace-other')
    expect(document.body.textContent).toContain('为角色「原角色」选择模型')
    expect(document.body.textContent).not.toContain('其他角色')
    await selectProfile('profile-one'); await click('用于当前角色并返回对话')
    expect(api.setAssignment).toHaveBeenCalledExactlyOnceWith('workspace-one', 'employee', 'employee-one', 'profile-one')
    expect(vi.mocked(api.listProfiles).mock.calls.at(-1)?.[0]).toBe('workspace-one')
  })

  it('makes world scope explicit for group-chat setup', async () => {
    await render({ worldId: 'world-one', worldName: '原世界' })
    expect(document.body.textContent).toContain('已有单独设置的角色不变')
    await selectProfile('profile-one'); await click('用于当前世界并返回对话')
    expect(api.setAssignment).toHaveBeenCalledExactlyOnceWith('workspace-one', 'world', 'world-one', 'profile-one')
  })

  it('advances from import to just imported model choices without assigning or selecting one', async () => {
    vi.mocked(api.listProfiles).mockResolvedValue({ profiles: [...profiles, makeProfile('other', 'other', 'other-provider')], assignments: [] })
    await render(); await fetchModels()
    await click('保存并导入模型池')
    expect(document.body.textContent).toContain('模型已导入，请选择一个用于此对话')
    expect(document.body.textContent).toContain('尚未验证对话或工具调用能力')
    expect(document.body.querySelectorAll('input[name="chat-setup-model"]')).toHaveLength(2)
    expect(document.body.querySelector('input[name="chat-setup-model"]:checked')).toBeNull()
    expect(api.setAssignment).not.toHaveBeenCalled()
    await selectProfile('profile-two'); await click('用于当前角色并返回对话')
    expect(api.setAssignment).toHaveBeenCalledExactlyOnceWith('workspace-one', 'employee', 'employee-one', 'profile-two')
  })

  it('retries a failed initial read without leaving a permanent loading state', async () => {
    vi.mocked(api.listProfiles).mockRejectedValueOnce(new Error('配置读取暂时失败'))
    await render()
    expect(document.body.textContent).toContain('配置读取暂时失败')
    expect(document.body.textContent).not.toContain('正在读取模型配置')
    await click('重新读取模型配置')
    expect(document.body.querySelectorAll('input[name="chat-setup-model"]')).toHaveLength(2)
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })

  it('retains selection and an actionable error after assignment failure', async () => {
    vi.mocked(api.setAssignment).mockRejectedValueOnce(new Error('服务暂时不可用'))
    await render(); await selectProfile('profile-one'); await click('用于当前角色并返回对话')
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('服务暂时不可用')
    expect(document.body.querySelector<HTMLInputElement>('input[name="chat-setup-model"]:checked')?.value).toBe('profile-one')
    expect(onClose).not.toHaveBeenCalled(); expect(onApplied).not.toHaveBeenCalled()
    await click('用于当前角色并返回对话')
    expect(api.setAssignment).toHaveBeenCalledTimes(2); expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps a submitted assignment visible until resolved and blocks duplicate submits', async () => {
    const pending = deferred<void>(); vi.mocked(api.setAssignment).mockReturnValue(pending.promise)
    await render(); await selectProfile('profile-one')
    const apply = button('用于当前角色并返回对话')
    await act(async () => { apply.click(); apply.click() })
    expect(api.setAssignment).toHaveBeenCalledTimes(1)
    expect(button('返回对话').disabled).toBe(true)
    await click('关闭模型中心')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => pending.resolve())
    expect(onClose).toHaveBeenCalledTimes(1); expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('does not call back into a different chat after unmount during assignment', async () => {
    const pending = deferred<void>(); vi.mocked(api.setAssignment).mockReturnValue(pending.promise)
    await render(); await selectProfile('profile-one'); await click('用于当前角色并返回对话')
    act(() => root.unmount()); mounted = false
    await act(async () => pending.resolve())
    expect(onClose).not.toHaveBeenCalled(); expect(onApplied).not.toHaveBeenCalled()
  })
})

describe('provider wizard request ownership', () => {
  it('retries a failed directory request against the row already saved', async () => {
    vi.mocked(api.testProvider).mockRejectedValueOnce(new Error('模型目录暂时不可用'))
    await render(); await fetchModels()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('模型目录暂时不可用')
    expect(api.saveProvider).toHaveBeenCalledTimes(1)
    await click('保存服务商并获取模型列表')
    expect(api.saveProvider).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.saveProvider).mock.calls[1]?.[1].id).toBe('provider-one')
    expect(document.body.textContent).toContain('选择要导入的模型')
  })

  it('keeps a failed import on the same saved provider and never preselects its eventual handoff', async () => {
    vi.mocked(api.importModels).mockRejectedValueOnce(new Error('导入暂时失败'))
    await render(); await fetchModels(); await click('保存并导入模型池')
    expect(document.body.querySelector('.model-hub__wizard')).not.toBeNull()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('导入暂时失败')
    expect(api.setAssignment).not.toHaveBeenCalled()
    await click('保存并导入模型池')
    expect(api.saveProvider).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.importModels).mock.calls.map((call) => call[1])).toEqual(['provider-one', 'provider-one'])
    expect(document.body.querySelector('input[name="chat-setup-model"]:checked')).toBeNull()
    expect(button('用于当前角色并返回对话').disabled).toBe(true)
  })

  it('saves only one provider under repeated clicks before a render', async () => {
    const pending = deferred<api.HubProvider>(); vi.mocked(api.saveProvider).mockReturnValue(pending.promise)
    await render(); await openLocalProvider()
    const save = button('保存服务商并获取模型列表')
    await act(async () => { save.click(); save.click() })
    expect(api.saveProvider).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(provider))
    expect(api.testProvider).toHaveBeenCalledTimes(1)
  })

  it('does not continue discovery or reopen the wizard after closing during save', async () => {
    const pending = deferred<api.HubProvider>(); vi.mocked(api.saveProvider).mockReturnValue(pending.promise)
    await render(); await fetchModels(); await click('返回对话')
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(provider))
    expect(api.testProvider).not.toHaveBeenCalled()
    expect(api.importModels).not.toHaveBeenCalled(); expect(api.setAssignment).not.toHaveBeenCalled()
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('does not reopen a cancelled wizard after discovery returns', async () => {
    const pending = deferred<api.DiscoveredModel[]>(); vi.mocked(api.testProvider).mockReturnValue(pending.promise)
    await render(); await fetchModels(); await click('取消并返回')
    await act(async () => pending.resolve([{ id: 'one' }]))
    expect(document.body.querySelector('.model-hub__wizard')).toBeNull()
    expect(api.importModels).not.toHaveBeenCalled(); expect(api.setAssignment).not.toHaveBeenCalled()
  })

  it('imports at most once and never assigns after leaving a pending import', async () => {
    const pending = deferred<{ created: number; updated: number }>(); vi.mocked(api.importModels).mockReturnValue(pending.promise)
    await render(); await fetchModels()
    const importButton = button('保存并导入模型池')
    await act(async () => { importButton.click(); importButton.click() })
    expect(api.importModels).toHaveBeenCalledTimes(1)
    await click('完成（服务商已保存，可稍后同步模型）')
    await act(async () => pending.resolve({ created: 2, updated: 0 }))
    expect(document.body.querySelector('.model-hub__wizard')).toBeNull()
    expect(document.body.textContent).not.toContain('模型已导入，请选择一个用于此对话')
    expect(api.setAssignment).not.toHaveBeenCalled(); expect(onApplied).not.toHaveBeenCalled()
  })
})
