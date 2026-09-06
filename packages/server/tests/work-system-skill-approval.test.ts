import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { BrowserPolicy, createCyberServer, type BrowserClient, type BrowserClientFactory, type BrowserResolvedTarget, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Task Center Skill approval', () => {
  it('pauses every task execution fact and continues the claimed run without preparing twice', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-work-skill-approval-'))
    roots.push(stateRoot)
    const browser = new RecordingBrowserFactory()
    const runtime = new RecordingRuntime()
    const server = await createCyberServer({
      stateRoot,
      workspacePath: stateRoot,
      port: 0,
      bootstrapDefaultWorld: true,
      runtime,
      browserClientFactory: browser,
      browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
    })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    await installBrowser(origin, workspace.id, world.id)
    expect((await postJson(`${origin}/api/employees/${employee.id}/revisions`, {
      reason: '任务中心审批测试', skillGrants: ['browser.read'], capabilityGrants: [], modelPolicy: {},
    })).status).toBe(201)
    const task = server.work.create({
      workspaceId: workspace.id,
      worldId: world.id,
      title: '读取公开页面',
      description: '请读取 https://example.com/task-center 并形成事实总结',
      priority: 'normal',
    })

    const waiting = await server.work.execute(task.id, { employeeIds: [employee.id], idempotencyKey: 'task-center-skill-1' })
    expect(waiting.task.status).toBe('waiting-approval')
    expect(waiting.runs).toMatchObject([{ status: 'waiting-approval' }])
    const run = waiting.runs[0]!
    expect(server.store.getWorkTurn(run.workTurnId)?.status).toBe('waiting-approval')
    expect(server.store.listTurnAgentRuns(run.workTurnId)).toEqual([])
    expect(runtime.calls).toEqual([])
    expect(browser.readUrls).toEqual([])
    const actions = server.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === run.workTurnId)
    expect(actions).toHaveLength(1)
    const approval = server.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === run.workTurnId)
    expect(approval).toBeDefined()

    const approved = await postJson(`${origin}/api/approvals/${approval!.id}/decision`, { decision: 'approved', scope: 'once' })
    expect(approved.status).toBe(200)
    const completed = server.work.detail(task.id)
    expect(completed.task.status).toBe('waiting-review')
    expect(completed.runs).toMatchObject([{ id: run.id, workTurnId: run.workTurnId, status: 'completed' }])
    expect(server.store.getWorkTurn(run.workTurnId)?.status).toBe('completed')
    expect(server.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === run.workTurnId)).toHaveLength(1)
    expect(browser.readUrls).toEqual(['https://example.com/task-center'])
    expect(runtime.calls.length).toBeGreaterThan(0)
    expect(runtime.calls.every((call) => call.workTurnId === run.workTurnId)).toBe(true)
    expect(runtime.calls.some((call) => call.prompt.includes('来自任务中心审批测试的事实'))).toBe(true)

    const rejectedTask = server.work.create({
      workspaceId: workspace.id, worldId: world.id, title: '拒绝读取',
      description: '请读取 https://example.com/rejected-task', priority: 'normal',
    })
    const rejectedWaiting = await server.work.execute(rejectedTask.id, { employeeIds: [employee.id], idempotencyKey: 'task-center-skill-reject' })
    const rejectedRun = rejectedWaiting.runs[0]!
    const rejectedApproval = server.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === rejectedRun.workTurnId)
    expect(rejectedApproval).toBeDefined()
    expect((await postJson(`${origin}/api/approvals/${rejectedApproval!.id}/decision`, { decision: 'rejected', scope: 'once' })).status).toBe(200)
    expect(server.work.detail(rejectedTask.id)).toMatchObject({ task: { status: 'waiting-review' }, runs: [{ id: rejectedRun.id, status: 'completed' }] })
    expect(server.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === rejectedRun.workTurnId)).toMatchObject([{ status: 'rejected' }])
    expect(browser.readUrls).toEqual(['https://example.com/task-center'])
    expect(runtime.calls.some((call) => call.workTurnId === rejectedRun.workTurnId && call.prompt.includes('未执行'))).toBe(true)
  }, 30_000)

  it('keeps a pending Task Center approval across restart and resumes the same facts', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-work-skill-restart-'))
    roots.push(stateRoot)
    const browser = new RecordingBrowserFactory()
    const first = await createCyberServer({
      stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true,
      runtime: new RecordingRuntime(), browserClientFactory: browser,
      browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
    })
    servers.push(first)
    const firstOrigin = (await first.start()).origin
    const workspace = first.store.listWorkspaces()[0]!
    const world = first.store.listWorlds(workspace.id)[0]!
    const employee = first.store.listEmployees(world.id)[0]!
    await installBrowser(firstOrigin, workspace.id, world.id)
    expect((await postJson(`${firstOrigin}/api/employees/${employee.id}/revisions`, {
      reason: '任务审批重启测试', skillGrants: ['browser.read'], capabilityGrants: [], modelPolicy: {},
    })).status).toBe(201)
    const task = first.work.create({
      workspaceId: workspace.id, worldId: world.id, title: '重启后读取',
      description: '请读取 https://example.com/restart-task', priority: 'normal',
    })
    const waiting = await first.work.execute(task.id, { employeeIds: [employee.id], idempotencyKey: 'task-skill-restart' })
    const run = waiting.runs[0]!
    const actionId = first.store.listWorldSkillActions(world.id).find((action) => action.workTurnId === run.workTurnId)!.id
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const raw = new DatabaseSync(join(stateRoot, 'data', 'dsh-cyber.sqlite'))
    expect(raw.prepare('SELECT status FROM task_runs WHERE id = ?').get(run.id)).toMatchObject({ status: 'waiting-approval' })
    raw.close()

    const recoveredRuntime = new RecordingRuntime()
    const recovered = await createCyberServer({
      stateRoot, workspacePath: stateRoot, port: 0, runtime: recoveredRuntime,
      browserClientFactory: browser,
      browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
    })
    servers.push(recovered)
    const recoveredOrigin = (await recovered.start()).origin
    expect(recovered.work.detail(task.id)).toMatchObject({
      task: { status: 'waiting-approval' }, runs: [{ id: run.id, status: 'waiting-approval' }],
    })
    const approval = recovered.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === run.workTurnId)!
    expect((await postJson(`${recoveredOrigin}/api/approvals/${approval.id}/decision`, { decision: 'approved', scope: 'once' })).status).toBe(200)
    expect(recovered.work.detail(task.id)).toMatchObject({
      task: { status: 'waiting-review' }, runs: [{ id: run.id, status: 'completed' }],
    })
    expect(recovered.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === run.workTurnId))
      .toMatchObject([{ id: actionId, status: 'executed' }])
    expect(browser.readUrls).toEqual(['https://example.com/restart-task'])
    expect(recoveredRuntime.calls.every((call) => call.workTurnId === run.workTurnId)).toBe(true)
  }, 30_000)

  it('runs a scheduled Skill through the shared queue and settles the same run after approval', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-schedule-skill-approval-'))
    roots.push(stateRoot)
    const browser = new RecordingBrowserFactory()
    const runtime = new RecordingRuntime()
    const server = await createCyberServer({
      stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, runtime,
      browserClientFactory: browser,
      browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
    })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    await installBrowser(origin, workspace.id, world.id)
    expect((await postJson(`${origin}/api/employees/${employee.id}/revisions`, {
      reason: '日程审批测试', skillGrants: ['browser.read'], capabilityGrants: [], modelPolicy: {},
    })).status).toBe(201)
    const created = await postJson<{ item: { id: string } }>(`${origin}/api/worlds/${world.id}/schedules`, {
      employeeId: employee.id,
      title: '计划读取',
      prompt: '请读取 https://example.com/scheduled-task 并形成事实总结',
      kind: 'once',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      permissionMode: 'read-only',
    })
    expect(created.status).toBe(201)
    const started = await postJson<{ run: { id: string; workTurnId: string; status: string } }>(
      `${origin}/api/worlds/${world.id}/schedules/${created.body.item.id}/run`, {},
    )
    expect(started.status).toBe(200)
    expect(started.body.run.status).toBe('waiting-approval')
    const run = started.body.run
    expect(server.store.getWorkTurn(run.workTurnId)?.status).toBe('waiting-approval')
    expect(server.store.getConversationQueueEntryByWorkTurn(world.id, run.workTurnId)?.status).toBe('waiting-approval')
    expect(server.store.listTurnAgentRuns(run.workTurnId)).toEqual([])
    expect(browser.readUrls).toEqual([])
    const approval = server.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === run.workTurnId)!
    expect((await postJson(`${origin}/api/approvals/${approval.id}/decision`, { decision: 'approved', scope: 'once' })).status).toBe(200)

    const runs = await getJson<{ items: Array<{ id: string; workTurnId: string; status: string }> }>(
      `${origin}/api/worlds/${world.id}/schedules/${created.body.item.id}/runs`,
    )
    expect(runs.items).toMatchObject([{ id: run.id, workTurnId: run.workTurnId, status: 'completed' }])
    expect(server.store.getConversationQueueEntryByWorkTurn(world.id, run.workTurnId)?.status).toBe('completed')
    expect(browser.readUrls).toEqual(['https://example.com/scheduled-task'])
    expect(runtime.calls.every((call) => call.workTurnId === run.workTurnId)).toBe(true)
    expect(server.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === run.workTurnId)).toHaveLength(1)
  }, 30_000)

})

async function installBrowser(origin: string, workspaceId: string, worldId: string): Promise<void> {
  const market = await getJson<{ items: Array<{ manifest: { id: string; version: string } }> }>(`${origin}/api/marketplace?market=plugin`)
  const item = market.items.find((candidate) => candidate.manifest.id === 'official-browser')!
  const preview = await postJson<{ preview: { approvalToken: string } }>(`${origin}/api/workspaces/${workspaceId}/marketplace/preview`, { packageId: item.manifest.id, version: item.manifest.version })
  expect((await postJson(`${origin}/api/workspaces/${workspaceId}/marketplace/install`, { packageId: item.manifest.id, version: item.manifest.version, approvalToken: preview.body.preview.approvalToken, worldId })).status).toBe(201)
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  return response.json() as Promise<T>
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}

class RecordingBrowserFactory implements BrowserClientFactory {
  readonly readUrls: string[] = []
  async create(_policy: BrowserPolicy, _target: BrowserResolvedTarget): Promise<BrowserClient> {
    return {
      open: async (url) => ({ url, title: 'Example', statusCode: 200 }),
      read: async (url) => { this.readUrls.push(url); return { url, title: 'Example', statusCode: 200, text: '来自任务中心审批测试的事实。' } },
      extract: async ({ url, selector }) => ({ url, title: 'Example', statusCode: 200, items: [{ selector, text: 'Example' }] }),
      screenshot: async ({ url, width = 640, height = 480 }) => ({ url, title: 'Example', statusCode: 200, bytes: Buffer.from('unused'), width, height, sha256: 'unused' }),
      close: async () => undefined,
    }
  }
}

class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  async runTurn(request: AgentTurnRequest) { this.calls.push(request); return { agentSessionId: `task-${request.agent.id}`, finalResponse: '已完成。', eventCount: 0 } }
  async close() {}
}
