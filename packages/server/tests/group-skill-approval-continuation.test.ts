import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import {
  BrowserPolicy,
  createCyberServer,
  type BrowserClient,
  type BrowserClientFactory,
  type BrowserResolvedTarget,
  type CyberServer,
} from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('group Skill approval continuation', () => {
  it('continues task approval and discussion rejection on the original group WorkTurn', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-group-skill-approval-'))
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
    const browserEmployee = server.store.listEmployees(world.id)[0]!
    const observer = server.store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'core.butler',
      blueprintVersion: 1,
      displayName: '观察角色',
    })
    await installBrowser(origin, workspace.id, world.id)
    const granted = await postJson(`${origin}/api/employees/${browserEmployee.id}/revisions`, {
      reason: '群聊浏览器审批测试',
      skillGrants: ['browser.read'],
      capabilityGrants: [],
      modelPolicy: {},
    })
    expect(granted.status).toBe(201)

    const task = await postJson<{ session: { id: string }; workTurnId: string; queueItem: { id: string } }>(`${origin}/api/worlds/${world.id}/chat`, {
      employeeIds: [observer.id, browserEmployee.id],
      prompt: '任务：请读取 https://example.com/task 并形成事实总结',
      collaborationMode: 'task',
      queueMode: 'normal',
      clientTurnId: 'group-skill-task-approval',
    })
    expect(task.status).toBe(202)
    await waitFor(
      () => server.store.getWorkTurn(task.body.workTurnId)?.status === 'waiting-approval',
      'task WorkTurn to enter waiting-approval',
      () => approvalWaitDiagnostics(server, world.id, task.body.workTurnId, task.body.queueItem.id),
    )
    expect(server.store.getConversationQueueEntry(task.body.queueItem.id)?.status).toBe('waiting-approval')
    expect(browser.readUrls).toEqual([])
    expect(runtime.calls).toEqual([])
    const taskApproval = server.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === task.body.workTurnId)
    expect(taskApproval).toBeDefined()

    const approved = await postJson(`${origin}/api/approvals/${taskApproval!.id}/decision`, { decision: 'approved', scope: 'once' })
    expect(approved.status).toBe(200)
    await waitFor(
      () => server.store.getWorkTurn(task.body.workTurnId)?.status === 'completed',
      'approved task WorkTurn to complete',
      () => approvalWaitDiagnostics(server, world.id, task.body.workTurnId, task.body.queueItem.id),
    )
    await waitFor(
      () => server.store.getConversationQueueEntry(task.body.queueItem.id)?.status === 'completed',
      'approved task queue item to complete',
      () => approvalWaitDiagnostics(server, world.id, task.body.workTurnId, task.body.queueItem.id),
    )
    const taskActions = server.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === task.body.workTurnId)
    expect(taskActions).toHaveLength(1)
    expect(taskActions[0]).toMatchObject({ characterId: browserEmployee.id, skillId: 'browser.read', status: 'executed' })
    expect(browser.readUrls).toEqual(['https://example.com/task'])
    expect(server.store.getTaskCollaborationPlanByTurn(world.id, task.body.workTurnId)).toMatchObject({ workTurnId: task.body.workTurnId, status: 'completed' })
    expect(server.store.listTurnAgentRuns(task.body.workTurnId).length).toBeGreaterThan(0)
    expect(runtime.calls.some((call) => call.prompt.includes('来自受控浏览器的真实公开网页事实'))).toBe(true)
    expect(server.store.listMessages(task.body.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)

    const callsBeforeReject = runtime.calls.length
    const discussion = await postJson<{ session: { id: string }; workTurnId: string; queueItem: { id: string } }>(`${origin}/api/worlds/${world.id}/chat`, {
      employeeIds: [observer.id, browserEmployee.id],
      prompt: '请读取 https://example.com/reject 后分别讨论',
      collaborationMode: 'discussion',
      queueMode: 'normal',
      clientTurnId: 'group-skill-discussion-reject',
    })
    expect(discussion.status).toBe(202)
    await waitFor(
      () => server.store.getWorkTurn(discussion.body.workTurnId)?.status === 'waiting-approval',
      'discussion WorkTurn to enter waiting-approval',
      () => approvalWaitDiagnostics(server, world.id, discussion.body.workTurnId, discussion.body.queueItem.id),
    )
    const rejectedApproval = server.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === discussion.body.workTurnId)
    expect(rejectedApproval).toBeDefined()
    const rejected = await postJson(`${origin}/api/approvals/${rejectedApproval!.id}/decision`, { decision: 'rejected', scope: 'once' })
    expect(rejected.status).toBe(200)
    await waitFor(
      () => server.store.getWorkTurn(discussion.body.workTurnId)?.status === 'completed',
      'rejected discussion WorkTurn to complete',
      () => approvalWaitDiagnostics(server, world.id, discussion.body.workTurnId, discussion.body.queueItem.id),
    )
    await waitFor(
      () => server.store.getConversationQueueEntry(discussion.body.queueItem.id)?.status === 'completed',
      'rejected discussion queue item to complete',
      () => approvalWaitDiagnostics(server, world.id, discussion.body.workTurnId, discussion.body.queueItem.id),
    )
    const rejectedActions = server.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === discussion.body.workTurnId)
    expect(rejectedActions).toHaveLength(1)
    expect(rejectedActions[0]).toMatchObject({ characterId: browserEmployee.id, skillId: 'browser.read', status: 'rejected' })
    expect(browser.readUrls).toEqual(['https://example.com/task'])
    expect(runtime.calls.slice(callsBeforeReject).some((call) => call.prompt.includes('未执行'))).toBe(true)
    expect(server.store.listMessages(discussion.body.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)
  })

  it('keeps a group approval pending across restart and resumes the same WorkTurn once', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-group-skill-approval-restart-'))
    roots.push(stateRoot)
    const browser = new RecordingBrowserFactory()
    const firstServer = await createCyberServer({
      stateRoot,
      workspacePath: stateRoot,
      port: 0,
      bootstrapDefaultWorld: true,
      runtime: new RecordingRuntime(),
      browserClientFactory: browser,
      browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
    })
    servers.push(firstServer)
    const firstOrigin = (await firstServer.start()).origin
    const workspace = firstServer.store.listWorkspaces()[0]!
    const world = firstServer.store.listWorlds(workspace.id)[0]!
    const browserEmployee = firstServer.store.listEmployees(world.id)[0]!
    const observer = firstServer.store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '重启观察角色' })
    await installBrowser(firstOrigin, workspace.id, world.id)
    expect((await postJson(`${firstOrigin}/api/employees/${browserEmployee.id}/revisions`, {
      reason: '重启审批测试',
      skillGrants: ['browser.read'],
      capabilityGrants: [],
      modelPolicy: {},
    })).status).toBe(201)
    const queued = await postJson<{ session: { id: string }; workTurnId: string; queueItem: { id: string } }>(`${firstOrigin}/api/worlds/${world.id}/chat`, {
      employeeIds: [observer.id, browserEmployee.id],
      prompt: '请读取 https://example.com/restart 并讨论',
      collaborationMode: 'discussion',
      queueMode: 'normal',
      clientTurnId: 'group-skill-restart',
    })
    await waitFor(
      () => firstServer.store.getWorkTurn(queued.body.workTurnId)?.status === 'waiting-approval',
      'restart scenario WorkTurn to enter waiting-approval',
      () => approvalWaitDiagnostics(firstServer, world.id, queued.body.workTurnId, queued.body.queueItem.id),
    )
    expect(browser.readUrls).toEqual([])
    await firstServer.close()

    const recoveredRuntime = new RecordingRuntime()
    const recovered = await createCyberServer({
      stateRoot,
      workspacePath: stateRoot,
      port: 0,
      runtime: recoveredRuntime,
      browserClientFactory: browser,
      browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
    })
    servers.push(recovered)
    const recoveredOrigin = (await recovered.start()).origin
    expect(recovered.store.getWorkTurn(queued.body.workTurnId)?.status).toBe('waiting-approval')
    expect(recovered.store.getConversationQueueEntry(queued.body.queueItem.id)?.status).toBe('waiting-approval')
    const approval = recovered.store.listWorldApprovalRequests(world.id, 'pending').find((request) => request.workTurnId === queued.body.workTurnId)
    expect(approval).toBeDefined()
    expect((await postJson(`${recoveredOrigin}/api/approvals/${approval!.id}/decision`, { decision: 'approved', scope: 'once' })).status).toBe(200)
    await waitFor(
      () => recovered.store.getWorkTurn(queued.body.workTurnId)?.status === 'completed',
      'recovered WorkTurn to complete',
      () => approvalWaitDiagnostics(recovered, world.id, queued.body.workTurnId, queued.body.queueItem.id),
    )
    await waitFor(
      () => recovered.store.getConversationQueueEntry(queued.body.queueItem.id)?.status === 'completed',
      'recovered queue item to complete',
      () => approvalWaitDiagnostics(recovered, world.id, queued.body.workTurnId, queued.body.queueItem.id),
    )
    expect(browser.readUrls).toEqual(['https://example.com/restart'])
    expect(recovered.store.listWorldSkillActions(world.id).filter((action) => action.workTurnId === queued.body.workTurnId)).toHaveLength(1)
    expect(recovered.store.listMessages(queued.body.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(recoveredRuntime.calls.length).toBeGreaterThan(0)
  })
})

async function installBrowser(origin: string, workspaceId: string, worldId: string): Promise<void> {
  const market = await getJson<{ items: Array<{ manifest: { id: string; version: string } }> }>(`${origin}/api/marketplace?market=plugin`)
  const item = market.items.find((candidate) => candidate.manifest.id === 'official-browser')
  expect(item).toBeDefined()
  const preview = await postJson<{ preview: { approvalToken: string } }>(`${origin}/api/workspaces/${workspaceId}/marketplace/preview`, {
    packageId: item!.manifest.id,
    version: item!.manifest.version,
  })
  expect(preview.status).toBe(200)
  const installed = await postJson(`${origin}/api/workspaces/${workspaceId}/marketplace/install`, {
    packageId: item!.manifest.id,
    version: item!.manifest.version,
    approvalToken: preview.body.preview.approvalToken,
    worldId,
  })
  expect(installed.status).toBe(201)
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json() as T
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  diagnostics?: () => unknown,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (predicate()) return
  let diagnosticText = ''
  try {
    const value = diagnostics?.()
    if (value !== undefined) diagnosticText = `; final state: ${JSON.stringify(value)}`
  } catch (cause) {
    diagnosticText = `; diagnostics failed: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${diagnosticText}`)
}

function approvalWaitDiagnostics(server: CyberServer, worldId: string, workTurnId: string, queueItemId: string) {
  const workTurn = server.store.getWorkTurn(workTurnId)
  const queueItem = server.store.getConversationQueueEntry(queueItemId)
  const pendingApprovals = server.store.listWorldApprovalRequests(worldId, 'pending')
    .filter((request) => request.workTurnId === workTurnId)
    .map((request) => ({ id: request.id, status: request.status, skillId: request.skillId }))
  return {
    workTurnStatus: workTurn?.status ?? 'missing',
    queueStatus: queueItem?.status ?? 'missing',
    queueAttemptCount: queueItem?.attemptCount,
    queueLeaseOwner: queueItem?.leaseOwner,
    queueLeaseExpiresAt: queueItem?.leaseExpiresAt,
    pendingApprovals,
  }
}

class RecordingBrowserFactory implements BrowserClientFactory {
  readonly readUrls: string[] = []

  async create(_policy: BrowserPolicy, _target: BrowserResolvedTarget): Promise<BrowserClient> {
    return {
      open: async (url) => ({ url, title: 'Example', statusCode: 200 }),
      read: async (url) => {
        this.readUrls.push(url)
        return { url, title: 'Example', statusCode: 200, text: '来自受控浏览器的真实公开网页事实。' }
      },
      extract: async ({ url, selector }) => ({ url, title: 'Example', statusCode: 200, items: [{ selector, text: 'Example' }] }),
      screenshot: async ({ url, width = 640, height = 480 }) => ({ url, title: 'Example', statusCode: 200, bytes: Buffer.from('unused'), width, height, sha256: 'unused' }),
      close: async () => undefined,
    }
  }
}

class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: '已根据持久化动作事实完成群聊回复。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}
