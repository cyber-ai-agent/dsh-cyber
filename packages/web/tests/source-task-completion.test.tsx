import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkTaskDetail, World } from '@dsh-cyber/contracts'
import { TaskWorkspace } from '../src/features/tasks/TaskWorkspace.js'
import '../src/i18n/messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

const world: World = { id: 'source-ui-world', workspaceId: 'workspace', name: '世界', templateId: 'cyber-company', status: 'active', createdAt: '', updatedAt: '' }
function makeDetail(id = 'a'): WorkTaskDetail {
  return {
    task: { id, workspaceId: world.workspaceId, worldId: world.id, title: `任务-${id}`, description: '核对已有结果', status: 'waiting-review', priority: 'normal', budget: {}, createdBy: 'owner', currentPlanRevision: 0, createdAt: '', updatedAt: '', sourceWorkTurnId: `turn-${id}`, sourceMessageId: `message-${id}` },
    plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [],
    sourceTurn: { workTurnId: `turn-${id}`, sessionId: `session-${id}`, status: 'completed', createdAt: '', runs: [], results: { messages: [{ id: 'reply', employeeId: 'employee', content: '<script>not code</script>已保存的结果', truncated: false }], artifacts: [{ artifactId: 'image', title: '已保存图片', version: 2, kind: 'image' }], hasMore: false } },
  }
}
let root: Root; let host: HTMLDivElement
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => { setUiLocale('zh-CN'); vi.stubGlobal('EventSource', undefined); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const render = () => act(async () => { root.render(createElement(TaskWorkspace, { world, employees: [] })) })
function button(label: string) { const value = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label); expect(value).toBeDefined(); return value! }

it('confirms an existing result through the completion API, refreshes the board, and never executes it again', async () => {
  let detail = makeDetail()
  const errors = vi.spyOn(console, 'error')
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/complete-source')) {
      expect(JSON.parse(String(init?.body))).toEqual({ sourceWorkTurnId: 'turn-a', confirmed: true })
      detail = { ...detail, task: { ...detail.task, status: 'completed' } }
      return json(detail)
    }
    return json(url.endsWith('/tasks') ? { items: [detail.task] } : url.endsWith('/artifacts') ? { artifacts: [] } : detail)
  }); vi.stubGlobal('fetch', fetch)
  await render()
  expect(host.querySelector('script')).toBeNull()
  expect(host.querySelector('.task-source-result img')?.getAttribute('src')).toBe('/api/worlds/source-ui-world/artifacts/image/preview/2')
  expect(host.querySelector('.task-source-retry')?.hasAttribute('open')).toBe(false)
  expect(host.textContent).not.toContain('还没有交付版本')
  await act(async () => button('确认完成').click())
  expect(host.textContent).toContain('已确认完成')
  expect(host.querySelector('.task-detail .task-status')?.textContent).toBe('已完成')
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/complete-source'))).toHaveLength(1)
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false)
  expect(errors).not.toHaveBeenCalled()
})

it('requires a note for an interrupted source and keeps the original status after a refused save', async () => {
  const detail = makeDetail(); detail.task.status = 'recovery-required'; detail.sourceTurn!.status = 'interrupted'; detail.sourceTurn!.errorCode = 'service-restarted'
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/complete-source')) {
      expect(JSON.parse(String(init?.body)).note).toBe('已经核对保存的图片')
      return json({ error: { code: 'work_task_source_turn_unsettled', message: '任务已变化，请刷新' } }, 409)
    }
    return json(url.endsWith('/tasks') ? { items: [detail.task] } : url.endsWith('/artifacts') ? { artifacts: [] } : detail)
  }); vi.stubGlobal('fetch', fetch)
  await render(); expect(button('确认完成').disabled).toBe(true)
  expect(host.textContent).toContain('服务重启时')
  await act(async () => {
    const textarea = host.querySelector('.task-source-confirm textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '已经核对保存的图片')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button('确认完成').disabled).toBe(false)
  await act(async () => button('确认完成').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('任务已变化')
  expect(host.textContent).not.toContain('已确认完成')
  expect(host.querySelector('.task-detail .task-status')?.textContent).not.toBe('已完成')
})

it('keeps a delayed confirmation with its original task while the owner selects another', async () => {
  const a = makeDetail('a'); const b = makeDetail('b'); let resolve!: (response: Response) => void
  const pending = new Promise<Response>((done) => { resolve = done })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/a/complete-source')) return pending
    return Promise.resolve(json(url.endsWith('/tasks') ? { items: [a.task, b.task] } : url.endsWith('/artifacts') ? { artifacts: [] } : url.endsWith('/b') ? b : a))
  }))
  await render(); await act(async () => button('确认完成').click())
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.task-board button')].find((item) => item.textContent?.includes('任务-b'))!.click())
  a.task.status = 'completed'; await act(async () => resolve(json(a)))
  expect(host.querySelector('.task-detail h2')?.textContent).toBe('任务-b')
  expect(host.querySelector('.task-detail .task-status')?.textContent).not.toBe('已完成')
})

it('keeps source completion copy in English on an English interface', async () => {
  setUiLocale('en-US'); const detail = makeDetail()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json(String(input).endsWith('/tasks') ? { items: [detail.task] } : String(input).endsWith('/artifacts') ? { artifacts: [] } : detail)))
  await render(); expect(button('Confirm completion').disabled).toBe(false)
  expect(host.querySelector('.task-source [role="status"]')?.textContent).toContain('The conversation has finished')
  expect(host.querySelector('.task-source [role="status"]')?.textContent).not.toMatch(/[\u4e00-\u9fff]/)
})
