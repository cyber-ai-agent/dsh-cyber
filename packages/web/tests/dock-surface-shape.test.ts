import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EmployeeDossier, TaskSchedule, WorkTask, World } from '@dsh-cyber/contracts'

import { BuiltinWorldMarket } from '../src/components/BuiltinWorldMarket.js'
import { EmployeeDossierDirectory } from '../src/components/EmployeeDossierDirectory.js'
import { TaskSchedulePanel } from '../src/components/TaskSchedulePanel.js'
import { ArtifactCenter } from '../src/features/artifacts/ArtifactCenter.js'
import type { ArtifactRecord } from '../src/features/artifacts/useWorldArtifacts.js'
import { TaskWorkspace } from '../src/features/tasks/TaskWorkspace.js'
import type { CyberEmployee } from '../src/types.js'

/**
 * The four pinned dock surfaces — role dossiers, the task list, the schedule
 * and the artifact list — were four separate implementations of the same
 * screen. The product rule for the dock is one main title, one primary
 * action and a clear list, with paths, ids and secondary explanation folded
 * into details. That rule only holds if the four surfaces share the shape
 * instead of each re-inventing a header, an empty state and a row.
 *
 * These assertions are about the shape, not the copy: a fifth hand-rolled
 * dock header has to fail here.
 */

const world: World = {
  id: 'dock-shape-world',
  workspaceId: 'dock-shape-workspace',
  name: '形状测试世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const employee: CyberEmployee = {
  id: 'employee-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  blueprintId: 'core.butler',
  blueprintVersion: 1,
  displayName: '阿帆',
  role: '性能工程师',
  presence: 'available',
  health: 'healthy',
  status: 'available',
  currentRevision: 1,
  avatarIndex: 0,
  summary: '独立 Agent',
  currentActivity: '正在核对本周的性能基线',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

const dossier: EmployeeDossier = {
  employee,
  revisions: [],
  skills: [],
  evidence: [],
  milestones: [],
  journals: [],
  relationships: [],
}

const task: WorkTask = {
  id: 'task-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  title: '整理本周的会议纪要',
  description: '把本周三场会议整理成一份纪要。',
  status: 'draft',
  priority: 'normal',
  budget: {},
  createdBy: 'owner',
  currentPlanRevision: 0,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
}

const schedule: TaskSchedule = {
  id: 'schedule-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  employeeId: employee.id,
  title: '每日整理项目进展',
  prompt: '汇总今天的项目进展。',
  kind: 'interval',
  status: 'active',
  scheduledAt: '2026-09-05T09:00:00.000Z',
  nextRunAt: '2026-09-05T09:00:00.000Z',
  everySeconds: 3600,
  timeZone: 'Asia/Shanghai',
  permissionMode: 'read-only',
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
}

const artifact: ArtifactRecord = {
  id: 'artifact-1',
  workspaceId: world.workspaceId,
  worldId: world.id,
  title: '产品说明',
  kind: 'markdown',
  status: 'active',
  currentVersion: 2,
  createdByKind: 'employee',
  createdById: employee.id,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:05:00.000Z',
  currentVersionInfo: {
    artifactId: 'artifact-1',
    version: 2,
    relativePath: 'v2/readme.md',
    sourceRelativePath: 'docs/readme.md',
    mimeType: 'text/markdown',
    byteLength: 128,
    sha256: 'hash',
    createdAt: '2026-09-04T00:00:00.000Z',
  },
}

/** Every dock surface, with the action that would fill it when it is empty. */
const SURFACES: Array<{ name: string; fillAction: string; render(populated: boolean): ReactElement }> = [
  {
    name: '角色档案',
    fillAction: '新增角色',
    render: (populated) => createElement(EmployeeDossierDirectory, {
      employees: populated ? [employee] : [],
      dossiers: populated ? { [employee.id]: dossier } : {},
      world,
      onOpen: vi.fn(),
      onDirect: vi.fn(),
      onManage: vi.fn(),
      onInvite: vi.fn(),
    }),
  },
  {
    name: '任务列表',
    fillAction: '新建任务',
    render: () => createElement(TaskWorkspace, { world, employees: [employee] }),
  },
  {
    name: '日程',
    fillAction: '新建日程',
    render: (populated) => createElement(TaskSchedulePanel, {
      employees: [employee],
      items: populated ? [schedule] : [],
      busy: false,
      onCreate: async () => undefined,
      onStatus: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
    }),
  },
  {
    name: '产物列表',
    fillAction: '从工作目录发布',
    render: (populated) => createElement(ArtifactCenter, { world, demoMode: true, initialArtifacts: populated ? [artifact] : [] }),
  },
]

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('the four dock surfaces share one shape', () => {
  it('gives every surface exactly one header title and one primary header action', async () => {
    for (const surface of SURFACES) {
      const mounted = await mount(surface.render(true), true)
      const headers = mounted.host.querySelectorAll('.dock-surface__header')
      expect(headers.length, `${surface.name}: one dock header`).toBe(1)
      const header = headers[0]!
      expect(header.querySelectorAll('h2').length, `${surface.name}: one main title`).toBe(1)
      expect(header.querySelector('h2')?.textContent, `${surface.name}: title text`).toBeTruthy()
      expect(header.querySelectorAll('.dock-surface__action > button').length, `${surface.name}: one primary action`).toBe(1)
      await mounted.unmount()
    }
  })

  it('gives every surface list rows with one title, one line of secondary text and a shared fold', async () => {
    for (const surface of SURFACES) {
      const mounted = await mount(surface.render(true), true)
      const rows = mounted.host.querySelectorAll('.dock-row')
      expect(rows.length, `${surface.name}: at least one shared row`).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.querySelectorAll('.dock-row__title').length, `${surface.name}: one row title`).toBe(1)
        expect(row.querySelectorAll('.dock-row__secondary').length, `${surface.name}: one line of secondary text`).toBe(1)
        // Everything past that one line belongs in the shared details fold, so
        // no surface grows its own disclosure widget.
        for (const fold of row.querySelectorAll('details')) {
          expect(fold.className, `${surface.name}: shared details fold`).toContain('dock-detail-fold')
        }
      }
      await mounted.unmount()
    }
  })

  it('marks the selected row with the shared selected state', async () => {
    const mounted = await mount(createElement(TaskWorkspace, { world, employees: [employee] }), true)
    const selected = mounted.host.querySelectorAll('.dock-row.is-selected')
    expect(selected.length).toBe(1)
    expect(selected[0]?.textContent).toContain(task.title)
    expect(selected[0]?.querySelector('[aria-current="true"]')).not.toBeNull()
    await mounted.unmount()
  })

  it('says what is empty and which action would fill it, on every surface', async () => {
    for (const surface of SURFACES) {
      const mounted = await mount(surface.render(false), false)
      const empties = mounted.host.querySelectorAll('.dock-empty-state')
      expect(empties.length, `${surface.name}: an empty state`).toBeGreaterThan(0)
      const empty = empties[0]!
      expect(empty.querySelectorAll('.dock-empty-state__title').length, `${surface.name}: names what is empty`).toBe(1)
      const description = empty.querySelector('.dock-empty-state__description')?.textContent ?? ''
      expect(description.length, `${surface.name}: explains the empty list`).toBeGreaterThan(8)
      // An honest empty state points at the action that would fill it, so the
      // reader never gets a decorative placeholder.
      expect(empty.textContent, `${surface.name}: names the filling action`).toContain(surface.fillAction)
      await mounted.unmount()
    }
  })
})

describe('built-in world templates read as available, never as an install', () => {
  it('offers a built-in template without claiming an install transaction', async () => {
    stubFetch({ templates: [{ id: 'ai-academy', displayName: 'AI 学院', summary: '一所可以旁听和提问的学院。' }] })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(BuiltinWorldMarket, { query: '', onCreate: async () => undefined })) })
    await vi.waitFor(() => expect(host.textContent).toContain('AI 学院'))

    const card = host.querySelector('.market-card-grid > article')
    expect(card).not.toBeNull()
    const text = card?.textContent ?? ''
    expect(text).not.toMatch(/已安装|安装成功|安装完成|已完成安装/)
    // The two theme grids have to read as one market, so a built-in card
    // carries the same state line the installed grid does — and that line has
    // to say plainly that nothing was installed.
    expect(card?.querySelector('.market-card-state')?.textContent, 'built-in state line').toContain('无需安装')
    expect(text).toContain('随应用提供')
    await act(async () => { root.unmount() })
    host.remove()
  })
})

async function mount(element: ReactElement, populated: boolean): Promise<{ host: HTMLElement; unmount(): Promise<void> }> {
  stubFetch({ tasks: populated ? [task] : [] })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => { root.render(element) })
  // TaskWorkspace loads through the API; the other three render from props.
  await act(async () => { await Promise.resolve() })
  return {
    host,
    async unmount() { await act(async () => { root.unmount() }); host.remove() },
  }
}

function stubFetch(data: { tasks?: WorkTask[]; templates?: unknown[] }): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/catalog/world-templates')) return json({ items: data.templates ?? [] })
    if (url.includes('/artifacts')) return json({ artifacts: [] })
    if (/\/api\/tasks\//.test(url)) return json(taskDetail())
    if (url.includes('/tasks')) return json({ items: data.tasks ?? [] })
    return json({})
  }))
}

const taskDetail = () => ({ task, plans: [], steps: [], assignments: [], runs: [], deliverables: [], reviews: [], growthEvidence: [] })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
