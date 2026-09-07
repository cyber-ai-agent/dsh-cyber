import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkTask, World } from '@dsh-cyber/contracts'
import { TaskWorkspace } from '../src/features/tasks/TaskWorkspace.js'
import '../src/i18n/messages.js'
import { setUiLocale } from '../src/i18n/runtime.js'

const world: World = { id: 'owner-world', workspaceId: 'workspace', name: '世界', templateId: 'cyber-company', status: 'active', createdAt: '', updatedAt: '' }
const task = (id: string, status: WorkTask['status'] = 'draft', worldId = world.id): WorkTask => ({ id, workspaceId: world.workspaceId, worldId, title: `任务-${id}`, description: `详情-${id}`, status, priority: 'normal', budget: {}, createdBy: 'owner', currentPlanRevision: 0, createdAt: '', updatedAt: '' })
const detail = (task: WorkTask) => ({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
let root: Root; let host: HTMLDivElement
beforeEach(() => { setUiLocale('zh-CN'); vi.stubGlobal('EventSource', undefined); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const render = (value = world) => act(async () => { root.render(createElement(TaskWorkspace, { world: value, employees: [] })) })
function select(label: string) { const button = [...host.querySelectorAll<HTMLButtonElement>('.task-board button')].find((button) => button.textContent?.includes(label)); expect(button).toBeDefined(); button!.click() }

it('does not let a delayed detail replace the task selected later; fetches one detail per selection', async () => {
  const pendingA = deferred<Response>(); const a = task('a'); const b = task('b')
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/tasks')) return Promise.resolve(json({ items: [a, b] }))
    if (url.endsWith('/artifacts')) return Promise.resolve(json({ artifacts: [] }))
    return url.endsWith('/a') ? pendingA.promise : Promise.resolve(json(detail(b)))
  }); vi.stubGlobal('fetch', fetch)
  await render(); await act(async () => select('任务-b'))
  expect(host.querySelector('.task-detail h2')?.textContent).toBe('任务-b')
  await act(async () => pendingA.resolve(json(detail(a))))
  expect(host.querySelector('.task-detail h2')?.textContent).toBe('任务-b')
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/tasks/a'))).toHaveLength(1)
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/api/tasks/b'))).toHaveLength(1)
})

it('does not apply a previous world list or selection after switching worlds', async () => {
  const pendingA = deferred<Response>(); const bWorld = { ...world, id: 'world-b' }; const b = task('b', 'draft', bWorld.id)
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith(`/${world.id}/tasks`)) return pendingA.promise
    if (url.endsWith('/tasks')) return Promise.resolve(json({ items: [b] }))
    if (url.endsWith('/artifacts')) return Promise.resolve(json({ artifacts: [] }))
    return Promise.resolve(json(detail(b)))
  }))
  await render(); await render(bWorld)
  await act(async () => pendingA.resolve(json({ items: [task('a')] })))
  expect(host.textContent).toContain('任务-b'); expect(host.textContent).not.toContain('任务-a')
})

it('ignores an old list response after the cancelled-task filter has changed again', async () => {
  const stale = deferred<Response>(); const a = task('a')
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('status=all')) return stale.promise
    if (url.endsWith('/tasks')) return Promise.resolve(json({ items: [a] }))
    if (url.endsWith('/artifacts')) return Promise.resolve(json({ artifacts: [] }))
    return Promise.resolve(json(detail(a)))
  }))
  await render(); await act(async () => select('显示已取消')); await act(async () => select('隐藏已取消'))
  await act(async () => stale.resolve(json({ items: [task('cancelled', 'cancelled')] })))
  expect(host.textContent).toContain('任务-a'); expect(host.textContent).not.toContain('任务-cancelled')
})

it('keeps planning, ready and recovery-required tasks visible in the board', async () => {
  const tasks = [task('planning', 'planning'), task('ready', 'ready'), task('recover', 'recovery-required')]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    return json(url.endsWith('/tasks') ? { items: tasks } : url.endsWith('/artifacts') ? { artifacts: [] } : detail(tasks[0]!))
  }))
  await render()
  for (const item of tasks) expect(host.querySelector('.task-board')?.textContent).toContain(item.title)
})
