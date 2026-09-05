import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, WorkTask, WorkTaskDetail } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

/**
 * Cancelling a task the owner does not want.
 *
 * A task can now be recorded by the host from a chat instruction, so a
 * misclassification leaves a draft nobody asked for. The safety valve is a
 * cancel, not a delete: the row stays with its plans, runs, deliverables and
 * reviews, it leaves the default list, and it stays readable on purpose.
 *
 * The one status that refuses is `running`: the execution owns that row and
 * settles it itself, so cancelling it would race a turn that is still in
 * flight.
 */

const servers: CyberServer[] = []
const roots: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Work Task cancel', () => {
  it('cancels a draft, keeps it readable, and takes it out of the default list', async () => {
    const context = await start()
    const task = await createTask(context, '误判产生的草稿', '这条任务是分类器搞错了，应该可以清掉。')

    const cancelled = await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(cancelled.body.task).toMatchObject({ id: task.id, status: 'cancelled' })

    // Gone from the default list, still there when asked for by name — the same
    // shape archived worlds use.
    expect((await get<{ items: WorkTask[] }>(context.origin, `/api/worlds/${context.worldId}/tasks`)).items).toEqual([])
    expect((await get<{ items: WorkTask[] }>(context.origin, `/api/worlds/${context.worldId}/tasks?status=cancelled`)).items.map((item) => item.id)).toEqual([task.id])
    expect((await get<{ items: WorkTask[] }>(context.origin, `/api/worlds/${context.worldId}/tasks?status=all`)).items.map((item) => item.id)).toEqual([task.id])

    // The row is not a dev cache: it reads back in full.
    const detail = await get<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}`)
    expect(detail.task).toMatchObject({ id: task.id, status: 'cancelled', title: '误判产生的草稿' })
  }, 30_000)

  it('refuses to cancel a running task and lets that execution finish', async () => {
    const gate = new Gate()
    const context = await start(gate)
    const task = await createTask(context, '正在执行的任务', '这条任务已经开始真实协作，不能被从下面抽走。')

    const execution = context.server.work.execute(task.id, { employeeIds: context.employeeIds, coordinatorEmployeeId: context.employeeIds[0]! })
    await gate.started
    expect(context.server.work.detail(task.id).task.status).toBe('running')

    const refused = await post<{ error: { code: string; message: string } }>(context.origin, `/api/tasks/${task.id}/cancel`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('work_task_not_cancellable')

    // The refusal did not touch the row: the turn that owns it still settles it.
    expect(context.server.work.detail(task.id).task.status).toBe('running')
    gate.release()
    const finished = await execution
    expect(finished.task.status).toBe('waiting-review')
    expect(finished.runs).toHaveLength(1)
  }, 30_000)

  it('refuses to execute a task after it was cancelled', async () => {
    const context = await start()
    const task = await createTask(context, '取消后不应再执行', '取消掉的任务不能再被启动。')
    expect((await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/cancel`, {})).status).toBe(200)

    await expect(context.server.work.execute(task.id, {
      employeeIds: context.employeeIds, coordinatorEmployeeId: context.employeeIds[0]!,
    })).rejects.toThrow()

    const started = await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/execute`, {
      employeeIds: context.employeeIds, coordinatorEmployeeId: context.employeeIds[0]!,
    })
    expect(started.status).not.toBe(200)
    const detail = await get<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}`)
    expect(detail.task.status).toBe('cancelled')
    expect(detail.runs).toEqual([])
  }, 30_000)

  it('refuses a second cancel instead of pretending it did something', async () => {
    const context = await start()
    const task = await createTask(context, '重复取消', '第二次取消应当被明确拒绝。')
    expect((await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/cancel`, {})).status).toBe(200)

    const again = await post<{ error: { code: string } }>(context.origin, `/api/tasks/${task.id}/cancel`, {})
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('work_task_not_cancellable')
    expect((await get<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}`)).task.status).toBe('cancelled')
  }, 30_000)

  it('cancels a task that asked for changes and keeps its plans, runs, deliverables and reviews', async () => {
    const context = await start()
    const task = await createTask(context, '要求修改后放弃', '这一版不想再改了，直接取消。')
    const run = await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/execute`, {
      employeeIds: context.employeeIds, coordinatorEmployeeId: context.employeeIds[0]!,
    })
    expect(run.status, JSON.stringify(run.body)).toBe(200)

    const filesPath = join(context.stateRoot, 'worlds', context.worldId, 'files')
    await mkdir(filesPath, { recursive: true })
    await writeFile(join(filesPath, 'delivery.md'), '# 第一版交付\n', 'utf8')
    const agentRun = context.server.store.listTurnAgentRuns(run.body.runs[0]!.workTurnId)[0]!
    const published = await context.server.artifacts.publishFromWorkspace({
      workspaceId: context.workspaceId, worldId: context.worldId, sourceRelativePath: 'delivery.md',
      title: '任务交付', kind: 'markdown', createdByKind: 'employee', createdById: agentRun.employeeId,
      employeeId: agentRun.employeeId, workTurnId: run.body.runs[0]!.workTurnId,
      agentRunId: agentRun.id, idempotencyKey: 'work-task-cancel-first',
    })
    const delivered = await post<{ deliverable: { id: string } }>(context.origin, `/api/tasks/${task.id}/deliverables`, {
      taskRunId: run.body.runs[0]!.id, submittedByEmployeeId: agentRun.employeeId,
      artifactId: published.artifact.id, artifactVersionId: published.version.version,
      title: '第一版交付', summary: '初版实现。', evidenceRefs: [`task-run:${run.body.runs[0]!.id}`],
    })
    const reviewed = await post<WorkTaskDetail>(context.origin, `/api/deliverables/${delivered.body.deliverable.id}/reviews`, {
      decision: 'request-changes', feedback: '这一版方向不对。',
    })
    expect(reviewed.body.task.status).toBe('changes-requested')

    const cancelled = await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(cancelled.body.task.status).toBe('cancelled')
    // Cancel, not delete.
    expect(cancelled.body.plans).toHaveLength(1)
    expect(cancelled.body.runs).toHaveLength(1)
    expect(cancelled.body.deliverables).toHaveLength(1)
    expect(cancelled.body.reviews).toHaveLength(1)
    expect(cancelled.body.assignments.length).toBeGreaterThan(0)
  }, 40_000)

  it('refuses to cancel a task that is waiting for review or already completed', async () => {
    const context = await start()
    const task = await createTask(context, '等待验收', '这条任务已经产出了交付，要用验收结束它。')
    const run = await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/execute`, {
      employeeIds: context.employeeIds, coordinatorEmployeeId: context.employeeIds[0]!,
    })
    expect(run.body.task.status).toBe('waiting-review')

    const refused = await post<{ error: { code: string } }>(context.origin, `/api/tasks/${task.id}/cancel`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('work_task_not_cancellable')
    expect((await get<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}`)).task.status).toBe('waiting-review')
  }, 40_000)

  it('cancels a failed task so a dead end can be cleared', async () => {
    const context = await start(undefined, true)
    const task = await createTask(context, '失败后放弃', '这条任务已经失败，不打算重试。')
    await expect(context.server.work.execute(task.id, {
      employeeIds: context.employeeIds, coordinatorEmployeeId: context.employeeIds[0]!,
    })).rejects.toThrow()
    expect(context.server.work.detail(task.id).task.status).toBe('failed')

    const cancelled = await post<WorkTaskDetail>(context.origin, `/api/tasks/${task.id}/cancel`, {})
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
    expect(cancelled.body.task.status).toBe('cancelled')
    expect((await get<{ items: WorkTask[] }>(context.origin, `/api/worlds/${context.worldId}/tasks`)).items).toEqual([])
  }, 30_000)
})

interface Context {
  server: CyberServer
  origin: string
  stateRoot: string
  workspaceId: string
  worldId: string
  employeeIds: string[]
}

async function start(gate?: Gate, failing = false): Promise<Context> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-work-task-cancel-'))
  roots.push(stateRoot)
  const server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true,
    runtime: new CancelRuntime(gate, failing),
  })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspaceId = server.store.listWorkspaces()[0]!.id
  const worldId = server.store.listWorlds(workspaceId)[0]!.id
  const coordinator = server.store.listEmployees(worldId)[0]!
  const recruit = await post<{ employee: { id: string } }>(origin, `/api/worlds/${worldId}/recruit`, {
    blueprintId: 'cyber-company.software-engineer', blueprintVersion: 1, displayName: '交付工程师', skillGrants: ['coding', 'testing'],
  })
  expect(recruit.status, JSON.stringify(recruit.body)).toBe(201)
  return { server, origin, stateRoot, workspaceId, worldId, employeeIds: [coordinator.id, recruit.body.employee.id] }
}

async function createTask(context: Context, title: string, description: string): Promise<WorkTask> {
  const created = await post<{ task: WorkTask }>(context.origin, `/api/worlds/${context.worldId}/tasks`, {
    title, description, priority: 'normal', coordinatorEmployeeId: context.employeeIds[0]!,
  })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  expect(created.body.task.status).toBe('draft')
  return created.body.task
}

/** Holds every agent turn open until the test lets go, so a task really is running. */
class Gate {
  readonly started: Promise<void>
  #begin!: () => void
  #open!: () => void
  readonly #held: Promise<void>

  constructor() {
    this.started = new Promise((resolve) => { this.#begin = resolve })
    this.#held = new Promise((resolve) => { this.#open = resolve })
  }

  async wait(): Promise<void> { this.#begin(); await this.#held }
  release(): void { this.#open() }
}

class CancelRuntime implements AgentRuntimePort {
  readonly #gate: Gate | undefined
  readonly #failing: boolean
  constructor(gate: Gate | undefined, failing: boolean) { this.#gate = gate; this.#failing = failing }
  async runTurn(request: AgentTurnRequest) {
    await this.#gate?.wait()
    if (this.#failing) throw new Error('模型服务不可达')
    return { agentSessionId: `cancel-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已完成分配步骤。`, eventCount: 0 }
  }
  async close() {}
}

async function post<T>(origin: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}
async function get<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`)
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`)
  return response.json() as Promise<T>
}
