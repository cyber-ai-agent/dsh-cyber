import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkTask, World } from '@dsh-cyber/contracts'

import { TaskWorkspace } from '../src/features/tasks/TaskWorkspace.js'

/**
 * The owner's way out of a task they never asked for.
 *
 * The panel has to offer the cancel, ask before it sends one, and then stop
 * showing the cancelled task in the default list — while still being able to
 * reveal it, because cancel keeps the row.
 */

const world: World = {
  id: 'task-cancel-world',
  workspaceId: 'task-cancel-workspace',
  name: '任务取消世界',
  templateId: 'cyber-company',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const draft: WorkTask = {
  id: 'task-to-cancel',
  workspaceId: world.workspaceId,
  worldId: world.id,
  title: '误判产生的草稿',
  description: '分类器把一句提问当成了指令。',
  status: 'draft',
  priority: 'normal',
  budget: {},
  createdBy: 'owner',
  currentPlanRevision: 0,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  sourceWorkTurnId: 'turn-from-chat',
  sourceMessageId: 'message-from-chat',
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Task cancel in the panel', () => {
  it('asks before cancelling, then drops the task from the default list but can reveal it', async () => {
    let task: WorkTask = draft
    const cancelCalls: string[] = []
    const listUrls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/cancel')) {
        cancelCalls.push(url)
        expect(init?.method).toBe('POST')
        task = { ...task, status: 'cancelled' }
        return json({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
      }
      if (url.includes('/tasks?') || url.endsWith('/tasks')) {
        listUrls.push(url)
        const revealing = url.includes('status=all') || url.includes('status=cancelled')
        return json({ items: task.status === 'cancelled' && !revealing ? [] : [task] })
      }
      if (url.endsWith('/artifacts')) return json({ artifacts: [] })
      return json({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(TaskWorkspace, { world, employees: [] })) })
    await vi.waitFor(() => expect(host.textContent).toContain('误判产生的草稿'))
    // The default list is the plain one: no reveal filter until the owner asks.
    expect(listUrls.every((url) => !url.includes('status='))).toBe(true)

    // One visible action, and it does not fire on the first click.
    const cancelButton = button(host, '取消任务')
    await act(async () => { cancelButton.click() })
    expect(cancelCalls).toEqual([])
    expect(host.textContent).toContain('取消后任务不再出现在默认列表')

    await act(async () => { button(host, '确认取消').click() })
    await vi.waitFor(() => expect(cancelCalls).toEqual([`/api/tasks/${draft.id}/cancel`]))
    await vi.waitFor(() => expect(host.textContent).not.toContain('误判产生的草稿'))
    expect(host.textContent).toContain('还没有任务')

    // Cancelled, not deleted: the owner can still look at it.
    await act(async () => { button(host, '显示已取消').click() })
    await vi.waitFor(() => expect(host.textContent).toContain('误判产生的草稿'))
    expect(listUrls.at(-1)).toContain('status=all')
    expect(host.textContent).toContain('已取消')
    // Nothing to cancel twice.
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.includes('取消任务'))).toBe(false)

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('does not carry an open confirm from one task to the next', async () => {
    const other: WorkTask = { ...draft, id: 'task-other', title: '另一条草稿', sourceWorkTurnId: 'turn-other' }
    const cancelled: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/cancel')) { cancelled.push(url); expect(init?.method).toBe('POST'); return json({ task: draft, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] }) }
      if (url.includes('/tasks?') || url.endsWith('/tasks')) return json({ items: [draft, other] })
      if (url.endsWith('/artifacts')) return json({ artifacts: [] })
      const task = url.includes(other.id) ? other : draft
      return json({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
    }))

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(TaskWorkspace, { world, employees: [] })) })
    await vi.waitFor(() => expect(host.textContent).toContain('误判产生的草稿'))

    // Open the confirm on the first task, then look at a different one without
    // answering it.
    await act(async () => { button(host, '取消任务').click() })
    expect(host.textContent).toContain('取消后任务不再出现在默认列表')
    await act(async () => { button(host, '另一条草稿').click() })
    await vi.waitFor(() => expect(host.textContent).toContain('另一条草稿'))

    // The second task must start from its own unopened state. Otherwise the
    // owner is one click away from cancelling a task they only meant to read.
    expect(host.textContent).not.toContain('取消后任务不再出现在默认列表')
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.includes('确认取消'))).toBe(false)
    expect(cancelled).toEqual([])

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('offers no cancel while a task is running', async () => {
    const running: WorkTask = { ...draft, id: 'task-running', title: '正在执行的任务', status: 'running' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/tasks?') || url.endsWith('/tasks')) return json({ items: [running] })
      if (url.endsWith('/artifacts')) return json({ artifacts: [] })
      return json({ task: running, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
    }))

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(TaskWorkspace, { world, employees: [] })) })
    await vi.waitFor(() => expect(host.textContent).toContain('正在执行的任务'))
    expect([...host.querySelectorAll('button')].some((node) => node.textContent?.includes('取消任务'))).toBe(false)

    await act(async () => { root.unmount() })
    host.remove()
  })
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(label))
  if (found === undefined) throw new Error(`Button not found: ${label} — ${[...host.querySelectorAll('button')].map((node) => node.textContent).join(' | ')}`)
  return found
}
