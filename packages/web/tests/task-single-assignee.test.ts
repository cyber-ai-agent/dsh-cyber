import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EmployeeInstance, WorkTask, World } from '@dsh-cyber/contracts'

import { TaskWorkspace } from '../src/features/tasks/TaskWorkspace.js'

/**
 * A personal task list has one person on it.
 *
 * The server stopped demanding two assignees, but the panel is where an owner
 * actually starts a task: while its button stays disabled below two, the
 * feature does not exist. The coordinator is part of the same fact — the server
 * refuses one who is not a member, so narrowing the roster has to narrow the
 * coordinator with it rather than keep whoever the task was created with.
 */

const world: World = {
  id: 'single-assignee-world',
  workspaceId: 'single-assignee-workspace',
  name: '个人助理世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

function employee(id: string, displayName: string): EmployeeInstance {
  return {
    id, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName,
    role: '管家', status: 'available', avatarIndex: 0, summary: '', currentActivity: '',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

const task: WorkTask = {
  id: 'task-for-one',
  workspaceId: world.workspaceId,
  worldId: world.id,
  title: '整理本周的会议纪要',
  description: '把本周三场会议整理成一份纪要。',
  status: 'draft',
  priority: 'normal',
  budget: {},
  createdBy: 'owner',
  // Created with 阿帆 coordinating; the owner then narrows the run to 小周.
  coordinatorEmployeeId: 'employee-fan',
  currentPlanRevision: 0,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Task panel with a single assignee', () => {
  it('runs a task with one person and coordinates it with that same person', async () => {
    const executions: Array<{ employeeIds: string[]; coordinatorEmployeeId?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/execute')) {
        executions.push(JSON.parse(String(init?.body)) as { employeeIds: string[]; coordinatorEmployeeId?: string })
        return json({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
      }
      if (url.includes('/tasks?') || url.endsWith('/tasks')) return json({ items: [task] })
      if (url.endsWith('/artifacts')) return json({ artifacts: [] })
      return json({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
    }))

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const employees = [employee('employee-fan', '阿帆'), employee('employee-zhou', '小周')]
    await act(async () => { root.render(createElement(TaskWorkspace, { world, employees })) })
    await vi.waitFor(() => expect(host.textContent).toContain('整理本周的会议纪要'))

    // The picker starts with everyone selected, so narrowing to one person is
    // what an owner actually does for a personal task.
    const run = button(host, '生成计划并执行')
    expect(run.disabled).toBe(false)
    await act(async () => { checkbox(host, '阿帆').click() })
    expect(host.querySelectorAll('.task-employee-picker input:checked')).toHaveLength(1)

    // The regression: one assignee left, and the only entry that starts a task
    // refuses to.
    expect(run.disabled).toBe(false)

    await act(async () => { run.click() })
    await vi.waitFor(() => expect(executions).toHaveLength(1))
    expect(executions[0]?.employeeIds).toEqual(['employee-zhou'])
    // Not 阿帆: the server refuses a coordinator outside the roster.
    expect(executions[0]?.coordinatorEmployeeId).toBe('employee-zhou')

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

function checkbox(host: HTMLElement, label: string): HTMLInputElement {
  const found = [...host.querySelectorAll('label')].find((node) => node.textContent?.includes(label))?.querySelector('input[type="checkbox"]')
  if (found === null || found === undefined) throw new Error(`Checkbox not found: ${label}`)
  return found as HTMLInputElement
}
