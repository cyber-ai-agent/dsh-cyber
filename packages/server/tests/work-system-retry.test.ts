import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, WorkTaskDetail } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Work System retry, single assignee and restart', () => {
  it('re-executes a failed task through the same execute path without a duplicate task', async () => {
    const f = await fixture()
    const task = createTask(f, '整理周报')

    f.runtime.failNextTurns = 1
    await expect(f.server.work.execute(task.id, roster(f))).rejects.toThrow()
    const failed = f.server.work.detail(task.id)
    expect(failed.task.status).toBe('failed')
    const failedRuns = f.server.store.listWorldAgentRuns(f.world.id).filter((run) => run.status === 'failed')
    expect(failedRuns).toHaveLength(1)
    const requestsAfterFailure = f.runtime.requests.length

    // The web retry control posts the same execute request again.
    const retried = await f.server.work.execute(task.id, roster(f))
    expect(retried.task).toMatchObject({ status: 'waiting-review', currentPlanRevision: 1 })
    expect(retried.runs).toHaveLength(1)
    expect(retried.runs[0]).toMatchObject({ attempt: 1, status: 'completed' })

    // Retry never rebuilds the task and never replays the failed attempt.
    expect(f.server.work.list(f.world.id)).toHaveLength(1)
    expect(f.runtime.requests.length - requestsAfterFailure).toBe(2)
    const runsNow = f.server.store.listWorldAgentRuns(f.world.id)
    expect(runsNow.filter((run) => run.status === 'failed').map((run) => run.id)).toEqual(failedRuns.map((run) => run.id))
    expect(f.server.store.getWorkTurn(failedRuns[0]!.turnId)).toMatchObject({ status: 'failed' })
    expect(runsNow.filter((run) => run.status === 'completed')).toHaveLength(2)

    // A rejected review also lands in failed; the HTTP retry the web client sends takes the same path.
    const rejected = f.server.work.review(await deliverFor(f, retried), { decision: 'reject', feedback: '方向不对，重来。' })
    expect(rejected.task.status).toBe('failed')
    const viaHttp = await post<WorkTaskDetail>(f.origin, `/api/tasks/${task.id}/execute`, roster(f))
    expect(viaHttp.status, JSON.stringify(viaHttp.body)).toBe(200)
    expect(viaHttp.body.task).toMatchObject({ status: 'waiting-review', currentPlanRevision: 2 })
    expect(viaHttp.body.runs.map((run) => run.attempt)).toEqual([1, 2])
    expect(viaHttp.body.reviews).toHaveLength(1)
    expect(viaHttp.body.deliverables.map((item) => item.status)).toEqual(['rejected'])
    expect(f.server.work.list(f.world.id)).toHaveLength(1)
  }, 30_000)

  it('executes a task with a single assignee end to end', async () => {
    const f = await fixture()
    const solo = createTask(f, '每日日程提醒')

    const detail = await f.server.work.execute(solo.id, { employeeIds: [f.coordinator.id] })
    expect(detail.task).toMatchObject({ status: 'waiting-review', coordinatorEmployeeId: f.coordinator.id, currentPlanRevision: 1 })
    expect(detail.steps).toHaveLength(1)
    expect(detail.steps[0]).toMatchObject({ assignedEmployeeIds: [f.coordinator.id], status: 'completed' })
    expect(detail.assignments.map((item) => item.employeeId)).toEqual([f.coordinator.id])
    expect(detail.runs[0]?.agentRunIds.length).toBeGreaterThan(0)
    expect(f.runtime.requests.length).toBeGreaterThan(0)
    expect(f.runtime.requests.every((request) => request.agent.id === f.coordinator.id)).toBe(true)

    // A sole assignee coordinates their own task even when the task was created with another coordinator.
    const handedOver = createTask(f, '同步客户邮件')
    const viaHttp = await post<WorkTaskDetail>(f.origin, `/api/tasks/${handedOver.id}/execute`, { employeeIds: [f.partner.id] })
    expect(viaHttp.status, JSON.stringify(viaHttp.body)).toBe(200)
    expect(viaHttp.body.task).toMatchObject({ status: 'waiting-review', coordinatorEmployeeId: f.partner.id })
    expect(viaHttp.body.assignments.map((item) => item.employeeId)).toEqual([f.partner.id])

    // Still refuses an empty roster and a coordinator outside the roster.
    const untouched = createTask(f, '空任务')
    await expect(f.server.work.execute(untouched.id, { employeeIds: [] })).rejects.toThrow('任务至少需要一名角色')
    await expect(f.server.work.execute(untouched.id, { employeeIds: [f.coordinator.id], coordinatorEmployeeId: f.partner.id })).rejects.toThrow('协调角色必须属于任务成员')
    const empty = await post<{ error: { code: string; message: string } }>(f.origin, `/api/tasks/${untouched.id}/execute`, { employeeIds: [] })
    expect(empty.status).toBe(422)
    expect(empty.body.error.message).toBe('任务角色至少需要一名')
    expect(f.server.work.detail(untouched.id).task.status).toBe('draft')

    // The multi-role path is unchanged.
    const pair = createTask(f, '联合评审')
    const paired = await f.server.work.execute(pair.id, roster(f))
    expect(paired.task).toMatchObject({ status: 'waiting-review', coordinatorEmployeeId: f.coordinator.id })
    expect(new Set(paired.assignments.map((item) => item.employeeId)).size).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('lands a task interrupted by a restart in failed and lets the same task be retried', async () => {
    const f = await fixture()
    const task = createTask(f, '导出季度报表')

    f.runtime.hold = true
    const inflight = f.server.work.execute(task.id, roster(f))
    inflight.catch(() => undefined)
    await waitFor(() => f.server.work.detail(task.id).task.status === 'running' && f.runtime.requests.length === 1)
    const liveRuns = f.server.store.listWorldAgentRuns(f.world.id).filter((run) => run.status === 'running')
    expect(liveRuns).toHaveLength(1)

    // The process dies while the model call is in flight: nothing releases the turn.
    await f.server.close()
    servers.splice(servers.indexOf(f.server), 1)

    const runtime = new ScriptedRuntime()
    const reopened = await boot(f.stateRoot, runtime)
    const recovered = reopened.server.work.detail(task.id)
    expect(reopened.server.store.getAgentRun(liveRuns[0]!.id)).toMatchObject({ status: 'failed', errorCode: 'service-restarted' })
    expect(reopened.server.store.getWorkTurn(liveRuns[0]!.turnId)).toMatchObject({ status: 'interrupted', errorCode: 'service-restarted' })
    expect(recovered.task.status).toBe('failed')
    expect(recovered.runs).toEqual([])
    expect(reopened.server.work.list(f.world.id)).toHaveLength(1)
    expect(runtime.requests).toHaveLength(0)

    const retried = await reopened.server.work.execute(task.id, roster(f))
    expect(retried.task).toMatchObject({ status: 'waiting-review', currentPlanRevision: 1 })
    expect(retried.runs).toHaveLength(1)
    expect(retried.runs[0]).toMatchObject({ attempt: 1, status: 'completed' })
    expect(reopened.server.work.list(f.world.id)).toHaveLength(1)
    expect(runtime.requests).toHaveLength(2)
    expect(reopened.server.store.getAgentRun(liveRuns[0]!.id)).toMatchObject({ status: 'failed', errorCode: 'service-restarted' })
  }, 30_000)

  it('leaves tasks in every other state alone on restart', async () => {
    const f = await fixture()
    const draft = createTask(f, '草稿任务')
    const done = createTask(f, '已交付任务')
    const delivered = await f.server.work.execute(done.id, roster(f))
    expect(delivered.task.status).toBe('waiting-review')

    await f.server.close()
    servers.splice(servers.indexOf(f.server), 1)
    const reopened = await boot(f.stateRoot, new ScriptedRuntime())
    expect(reopened.server.work.detail(draft.id).task.status).toBe('draft')
    expect(reopened.server.work.detail(done.id).task).toMatchObject({ status: 'waiting-review', currentPlanRevision: 1 })
    expect(reopened.server.work.list(f.world.id)).toHaveLength(2)
  }, 30_000)
})

class ScriptedRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []
  /** Reject this many upcoming turns, the way a model provider does. */
  failNextTurns = 0
  /** Park every turn until `release()`; nothing releases them in the restart test. */
  hold = false
  readonly #held: Array<() => void> = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    if (this.failNextTurns > 0) {
      this.failNextTurns -= 1
      throw new Error('模型服务拒绝了本次请求')
    }
    if (this.hold) await new Promise<void>((resolve) => this.#held.push(resolve))
    return { agentSessionId: `retry-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已完成分配步骤。`, eventCount: 0 }
  }

  release(): void { for (const resolve of this.#held.splice(0)) resolve() }
  async close(): Promise<void> {}
}

interface Fixture {
  stateRoot: string
  runtime: ScriptedRuntime
  server: CyberServer
  origin: string
  workspace: { id: string }
  world: { id: string }
  coordinator: { id: string }
  partner: { id: string }
}

async function boot(stateRoot: string, runtime: ScriptedRuntime, bootstrapDefaultWorld = false): Promise<{ server: CyberServer; origin: string }> {
  const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld, runtime })
  servers.push(server)
  const origin = (await server.start()).origin
  return { server, origin }
}

async function fixture(): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-work-retry-'))
  roots.push(stateRoot)
  const runtime = new ScriptedRuntime()
  const { server, origin } = await boot(stateRoot, runtime, true)
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const coordinator = server.store.listEmployees(world.id)[0]!
  const recruit = await post<{ employee: { id: string } }>(origin, `/api/worlds/${world.id}/recruit`, {
    blueprintId: 'cyber-company.software-engineer', blueprintVersion: 1, displayName: '交付工程师', skillGrants: ['coding', 'testing'],
  })
  expect(recruit.status).toBe(201)
  return { stateRoot, runtime, server, origin, workspace, world, coordinator, partner: recruit.body.employee }
}

function createTask(f: Fixture, title: string) {
  return f.server.work.create({
    workspaceId: f.workspace.id, worldId: f.world.id, title, description: `${title}：形成一份可审阅的结果。`, priority: 'normal', coordinatorEmployeeId: f.coordinator.id,
  })
}

function roster(f: Fixture): { employeeIds: string[]; coordinatorEmployeeId: string } {
  return { employeeIds: [f.coordinator.id, f.partner.id], coordinatorEmployeeId: f.coordinator.id }
}

/** Publishes a real artifact version for the latest run and submits it, so a review can happen. */
async function deliverFor(f: Fixture, detail: WorkTaskDetail): Promise<string> {
  const run = detail.runs.at(-1)!
  const author = f.server.store.getAgentRun(run.agentRunIds[0]!)!.employeeId
  const { mkdir, writeFile } = await import('node:fs/promises')
  const filesPath = join(f.stateRoot, 'worlds', f.world.id, 'files')
  await mkdir(filesPath, { recursive: true })
  await writeFile(join(filesPath, `${detail.task.id}.md`), `# ${detail.task.title}\n`, 'utf8')
  const published = await f.server.artifacts.publishFromWorkspace({
    workspaceId: f.workspace.id, worldId: f.world.id, sourceRelativePath: `${detail.task.id}.md`, title: detail.task.title, kind: 'markdown',
    createdByKind: 'employee', createdById: author, employeeId: author,
    workTurnId: run.workTurnId, agentRunId: run.agentRunIds[0], idempotencyKey: `retry-${detail.task.id}-${run.attempt}`,
  })
  const deliverable = f.server.work.submitDeliverable({
    taskId: detail.task.id, taskRunId: run.id, submittedByEmployeeId: author,
    artifactId: published.artifact.id, artifactVersionId: published.version.version, title: detail.task.title, summary: '第一版结果。',
  })
  return deliverable.id
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function post<T>(origin: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}
