import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { World, WorkTask } from '@dsh-cyber/contracts'

import { TaskWorkspace } from '../src/features/tasks/TaskWorkspace.js'

/**
 * A task the conversation recorded arrives while the panel is already open, so
 * it has to appear without a reload — and it has to say where it came from, or
 * the owner sees a task they never typed.
 */

const world: World = {
  id: 'task-live-world',
  workspaceId: 'task-live-workspace',
  name: '任务实时世界',
  templateId: 'cyber-company',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const proposed: WorkTask = {
  id: 'task-from-chat',
  workspaceId: world.workspaceId,
  worldId: world.id,
  title: '整理用户反馈改进清单',
  description: '汇总上周用户反馈，输出一份带优先级的改进清单。',
  status: 'draft',
  priority: 'high',
  budget: {},
  createdBy: 'owner',
  currentPlanRevision: 0,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
  sourceWorkTurnId: 'turn-from-chat',
  sourceMessageId: 'message-from-chat',
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly #listeners = new Map<string, Set<(event: Event) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(new Event(type))
  }

  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

describe('Task list live refresh', () => {
  it('shows a task recorded by the conversation on world-task, and marks where it came from', async () => {
    let tasks: WorkTask[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.endsWith('/tasks')
        ? { items: tasks }
        : url.endsWith('/artifacts')
          ? { artifacts: [] }
          : { task: tasks[0], plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(TaskWorkspace, { world, employees: [] })) })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/worlds/${world.id}/live`)
    expect(host.textContent).not.toContain('整理用户反馈改进清单')

    const before = fetchMock.mock.calls.length
    await act(async () => { FakeEventSource.instances[0]?.emit('world-state') })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchMock.mock.calls).toHaveLength(before)

    tasks = [proposed]
    await act(async () => { FakeEventSource.instances[0]?.emit('world-task') })
    await vi.waitFor(() => expect(host.textContent).toContain('整理用户反馈改进清单'))
    // Draft, not running: recording a task never starts one, so the panel still
    // offers the action that starts it.
    expect(host.textContent).toContain('开始真实协作')
    expect(host.textContent).toContain('来自对话')

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('tells the owner what the turn that asked for the draft actually did, without claiming the task ran', async () => {
    const detail = {
      task: proposed,
      plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [],
      sourceTurn: {
        workTurnId: 'turn-from-chat',
        sessionId: 'session-from-chat',
        status: 'completed',
        createdAt: '2026-09-04T00:00:00.000Z',
        startedAt: '2026-09-04T00:00:01.000Z',
        completedAt: '2026-09-04T00:00:09.000Z',
        runs: [{ id: 'run-from-chat', employeeId: 'employee-1', status: 'completed', startedAt: '2026-09-04T00:00:01.000Z', completedAt: '2026-09-04T00:00:09.000Z' }],
      },
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.endsWith('/tasks') ? { items: [proposed] } : url.endsWith('/artifacts') ? { artifacts: [] } : detail
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(TaskWorkspace, { world, employees: [] })) })
    await vi.waitFor(() => expect(host.textContent).toContain('来源对话'))

    // The source turn: which turn, how it ended, and how many characters ran in
    // it — the execution the draft came out of.
    expect(host.textContent).toContain('turn-fro')
    expect(host.textContent).toContain('已完成')
    expect(host.textContent).toContain('1 个角色运行')
    // And the line that keeps it honest: that turn is not this task's own work.
    expect(host.textContent).toContain('不是任务本身的执行')
    // The task is still a draft, so starting it is still the owner's click.
    expect(host.textContent).toContain('开始真实协作')

    await act(async () => { root.unmount() })
    host.remove()
  })
})
