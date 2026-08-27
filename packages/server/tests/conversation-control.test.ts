import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { createCyberServer, type CyberServer } from '../src/index.js'
import { ConversationQueueService } from '../src/services/conversation-queue-service.js'

const servers: CyberServer[] = []
const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class QueueRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  readonly aborted: string[] = []
  #pending = new Map<string, { reject: (error: unknown) => void }>()

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    if (request.prompt.includes('单轮失败')) throw new Error('single turn failed')
    if (request.prompt.includes('并发') || request.prompt.includes('请停止')) {
      return await new Promise<never>((_resolve, reject) => {
        if (request.agentRunId !== undefined) this.#pending.set(request.agentRunId, { reject })
      })
    }
    return {
      agentSessionId: `runtime-${request.agent.id}`,
      finalResponse: `已完成：${request.prompt}`,
      eventCount: 0,
    }
  }

  async abortRun(agentRunId: string): Promise<void> {
    this.aborted.push(agentRunId)
    const pending = this.#pending.get(agentRunId)
    this.#pending.delete(agentRunId)
    pending?.reject(new Error('runtime aborted'))
  }

  async close(): Promise<void> {}
}

async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-conversation-control-'))
  roots.push(stateRoot)
  const runtime = new QueueRuntime()
  const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, runtime, bootstrapDefaultWorld: true })
  servers.push(server)
  const address = await server.start()
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  return { origin: address.origin, server, runtime, world, employee }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for conversation queue')
}

describe('Conversation control and durable queue', () => {
  it('claims a queued WorkTurn and continues the original turn without rebuilding it', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const queued = await json(origin, `/api/worlds/${world.id}/chat-queue`, post({
      employeeIds: [employee.id],
      prompt: '排队执行一次真实回复',
      queueMode: 'normal',
      clientTurnId: 'client-queued-once',
    }))
    expect(queued.response.status).toBe(202)
    expect(queued.body.queueItem.workTurnId).toBe(queued.body.workTurnId)
    await waitFor(() => server.store.getWorkTurn(queued.body.workTurnId)?.status === 'completed')
    const visible = await json(origin, `/api/worlds/${world.id}/chat-queue?status=completed`)
    expect(visible.body.items[0]).toMatchObject({
      id: 'client-queued-once',
      serverQueueId: queued.body.queueItem.id,
      queueKey: `direct:${employee.id}`,
      workTurnId: queued.body.workTurnId,
    })
    const runs = server.store.listTurnAgentRuns(queued.body.workTurnId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'completed', turnId: queued.body.workTurnId })
    expect(runtime.calls).toHaveLength(1)
    const messages = server.store.listMessages(queued.body.session.id)
    expect(messages.filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(messages.some((message) => message.kind === 'assistant')).toBe(true)
    const terminalStop = await json(origin, `/api/turns/${queued.body.workTurnId}/abort`, post({ reason: 'late-stop' }))
    expect(terminalStop.response.status).toBe(200)
    expect(terminalStop.body.entry.status).toBe('completed')
  })

  it('stops a running queued turn as interrupted and leaves no failed status', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const queued = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id],
      prompt: '请停止这个长任务',
      queueMode: 'normal',
    }))
    expect(queued.response.status).toBe(202)
    await waitFor(() => server.store.getWorkTurn(queued.body.workTurnId)?.status === 'running' && runtime.calls.length === 1)
    const stopped = await json(origin, `/api/turns/${queued.body.workTurnId}/abort`, post({ reason: 'user-stop' }))
    expect(stopped.response.status).toBe(200)
    await waitFor(() => server.store.getWorkTurn(queued.body.workTurnId)?.status === 'interrupted')
    expect(runtime.aborted).toHaveLength(1)
    expect(server.store.listTurnAgentRuns(queued.body.workTurnId)[0]).toMatchObject({ status: 'interrupted', errorCode: 'interrupted' })
    expect(server.store.listMessages(queued.body.session.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'system', content: '已停止' })]),
    )
  })

  it('keeps a third same-employee queue entry queued until one of two lanes stops', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const sessions = [1, 2, 3, 4].map((index) => server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title: `并发会话 ${index}`,
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    }))
    const queue = async (sessionId: string, index: number) => json(origin, `/api/worlds/${world.id}/chat-queue`, post({
      employeeIds: [employee.id],
      sessionId,
      prompt: `并发任务 ${index}`,
      queueMode: 'normal',
    }))
    const first = await queue(sessions[0]!.id, 1)
    const second = await queue(sessions[1]!.id, 2)
    const third = await queue(sessions[2]!.id, 3)
    const fourth = await queue(sessions[3]!.id, 4)
    expect([first.response.status, second.response.status, third.response.status, fourth.response.status]).toEqual([202, 202, 202, 202])
    await waitFor(() => runtime.calls.length === 2)
    expect(server.store.getEmployee(employee.id)).toMatchObject({ presence: 'working', health: 'healthy', status: 'working' })
    expect(server.store.getConversationQueueEntry(third.body.queueItem.id)?.status).toBe('queued')
    expect(server.store.getConversationQueueEntry(fourth.body.queueItem.id)?.status).toBe('queued')

    const promoted = await json(origin, `/api/worlds/${world.id}/chat-queue/${third.body.queueItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueMode: 'next' }),
    })
    expect(promoted.response.status).toBe(200)
    const cancelled = await json(origin, `/api/worlds/${world.id}/chat-queue/${fourth.body.queueItem.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
    expect(cancelled.response.status).toBe(200)
    expect(server.store.getConversationQueueEntry(fourth.body.queueItem.id)?.status).toBe('cancelled')

    const stopped = await json(origin, `/api/work-turns/${first.body.workTurnId}/abort`, post({ reason: 'user-stop' }))
    expect(stopped.response.status).toBe(200)
    await waitFor(() => server.store.getConversationQueueEntry(third.body.queueItem.id)?.status === 'running')
    expect(server.store.getConversationQueueEntry(second.body.queueItem.id)?.status).toBe('running')
    expect(server.store.getEmployee(employee.id)).toMatchObject({ presence: 'working', health: 'healthy', status: 'working' })
    expect(runtime.aborted).toHaveLength(1)

    await json(origin, `/api/work-turns/${second.body.workTurnId}/abort`, post({ reason: 'test-finished' }))
    await json(origin, `/api/work-turns/${third.body.workTurnId}/abort`, post({ reason: 'test-finished' }))
    await waitFor(() => server.store.getEmployee(employee.id)?.presence === 'available')
    expect(server.store.getEmployee(employee.id)).toMatchObject({ presence: 'available', health: 'healthy', status: 'available' })
  })

  it('keeps presence working when one concurrent turn fails and another is still active', async () => {
    const { origin, server, world, employee } = await start()
    const createSession = (title: string) => server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title,
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const activeSession = createSession('持续运行会话')
    const failingSession = createSession('单轮失败会话')
    const active = await json(origin, `/api/worlds/${world.id}/chat-queue`, post({
      employeeIds: [employee.id],
      sessionId: activeSession.id,
      prompt: '并发任务保持运行',
      queueMode: 'normal',
    }))
    const failing = await json(origin, `/api/worlds/${world.id}/chat-queue`, post({
      employeeIds: [employee.id],
      sessionId: failingSession.id,
      prompt: '单轮失败',
      queueMode: 'normal',
    }))

    await waitFor(() => server.store.getWorkTurn(failing.body.workTurnId)?.status === 'failed')
    expect(server.store.getEmployee(employee.id)).toMatchObject({ presence: 'working', health: 'healthy', status: 'working' })

    await json(origin, `/api/work-turns/${active.body.workTurnId}/abort`, post({ reason: 'test-finished' }))
    await waitFor(() => server.store.getEmployee(employee.id)?.presence === 'available')
    expect(server.store.getEmployee(employee.id)).toMatchObject({ presence: 'available', health: 'healthy', status: 'available' })
  })

  it('keeps follow-up messages in one conversation ordered on a single lane', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const session = server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title: '同一会话顺序测试',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const first = await json(origin, `/api/worlds/${world.id}/chat-queue`, post({
      employeeIds: [employee.id],
      sessionId: session.id,
      prompt: '请停止这个长任务，先保持第一条运行',
      queueMode: 'normal',
    }))
    const followUp = await json(origin, `/api/worlds/${world.id}/chat-queue`, post({
      employeeIds: [employee.id],
      sessionId: session.id,
      prompt: '第二条必须等待第一条结束',
      queueMode: 'normal',
    }))
    await waitFor(() => runtime.calls.length === 1)
    expect(server.store.getConversationQueueEntry(first.body.queueItem.id)?.status).toBe('running')
    expect(server.store.getConversationQueueEntry(followUp.body.queueItem.id)?.status).toBe('queued')

    await json(origin, `/api/turns/${first.body.workTurnId}/abort`, post({ reason: 'user-stop' }))
    await waitFor(() => server.store.getWorkTurn(followUp.body.workTurnId)?.status === 'completed')
    expect(runtime.calls).toHaveLength(2)
  })

  it('queues a group discussion and continues the same WorkTurn without duplicating the user message', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const colleague = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'core.butler',
      blueprintVersion: 1,
      displayName: '协作角色',
    })
    const market = await json(origin, '/api/marketplace?market=plugin')
    const meetingPlugin = (market.body.items as Array<{ manifest: { id: string; version: string } }>).find((item) => item.manifest.id === 'official-meeting-notes')
    expect(meetingPlugin).toBeDefined()
    const preview = await json(origin, `/api/workspaces/${world.workspaceId}/marketplace/preview`, post({ packageId: meetingPlugin!.manifest.id, version: meetingPlugin!.manifest.version }))
    const installed = await json(origin, `/api/workspaces/${world.workspaceId}/marketplace/install`, post({
      packageId: meetingPlugin!.manifest.id,
      version: meetingPlugin!.manifest.version,
      approvalToken: preview.body.preview.approvalToken,
      worldId: world.id,
    }))
    expect(installed.response.status).toBe(201)
    const queued = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id, colleague.id],
      prompt: '/meeting-summary 请讨论这份交付方案并分别给出意见',
      collaborationMode: 'discussion',
      queueMode: 'normal',
      clientTurnId: 'group-discussion-queued',
    }))
    expect(queued.response.status).toBe(202)
    await waitFor(() => server.store.getWorkTurn(queued.body.workTurnId)?.status === 'completed')
    expect(server.store.listTurnAgentRuns(queued.body.workTurnId)).toHaveLength(2)
    expect(runtime.calls).toHaveLength(2)
    for (const call of runtime.calls) expect(call.prompt).toContain('当前世界的会议纪要助手')
    const messages = server.store.listMessages(queued.body.session.id)
    expect(messages.filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(server.store.listSessionTurns(queued.body.session.id)).toHaveLength(1)
    expect(server.store.getConversationQueueEntry(queued.body.queueItem.id)).toMatchObject({
      conversationKind: 'group',
      collaborationMode: 'discussion',
      status: 'completed',
    })
  })

  it('queues task collaboration, persists one plan on the original WorkTurn, and runs the coordinator once', async () => {
    const { origin, server, world, employee } = await start()
    const colleague = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'core.butler',
      blueprintVersion: 1,
      displayName: '任务协作角色',
    })
    const queued = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id, colleague.id],
      prompt: '任务：整理当前交付信息并形成一份协调总结',
      collaborationMode: 'task',
      queueMode: 'next',
      clientTurnId: 'group-task-queued',
      coordinatorEmployeeId: employee.id,
    }))
    expect(queued.response.status).toBe(202)
    await waitFor(() => ['completed', 'failed'].includes(server.store.getWorkTurn(queued.body.workTurnId)?.status ?? ''))
    expect(server.store.getWorkTurn(queued.body.workTurnId)?.status).toBe('completed')
    const plan = server.store.getTaskCollaborationPlanByTurn(world.id, queued.body.workTurnId)
    expect(plan).toMatchObject({ workTurnId: queued.body.workTurnId, sessionId: queued.body.session.id, status: 'completed' })
    expect(server.store.listSessionTurns(queued.body.session.id)).toHaveLength(1)
    expect(server.store.listMessages(queued.body.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)
    const expectedRuns = plan!.steps.reduce((count, step) => count + step.assignedEmployeeIds.length, 0) + 1
    expect(server.store.listTurnAgentRuns(queued.body.workTurnId)).toHaveLength(expectedRuns)
  })

  it('keeps waiting approval as a session lock while releasing the employee lane to another session', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-waiting-approval-order-'))
    roots.push(stateRoot)
    const store = await SqliteStore.open(join(stateRoot, 'queue.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '队列顺序测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '队列世界', templateId: 'personal-world' })
    store.saveBlueprint(testBlueprint())
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'queue.employee', blueprintVersion: 1 })
    const sessionA = createDirectSession(store, workspace.id, world.id, employee.id, '会话 A')
    const sessionB = createDirectSession(store, workspace.id, world.id, employee.id, '会话 B')
    const first = enqueueStoredTurn(store, workspace.id, world.id, sessionA.id, employee.id, '等待审批的第一条')
    const followUp = enqueueStoredTurn(store, workspace.id, world.id, sessionA.id, employee.id, '同会话第二条')
    const independent = enqueueStoredTurn(store, workspace.id, world.id, sessionB.id, employee.id, '另一会话可运行')
    store.promoteConversationQueueEntry(first.id, first.revision)
    let releaseIndependent: (() => void) | undefined
    const seen: string[] = []
    const queue = new ConversationQueueService({
      store,
      orchestrator: { interruptWorkTurn: async () => undefined } as unknown as ConversationOrchestrator,
      runner: async (entry) => {
        seen.push(entry.id)
        if (entry.id === first.id) return { waitingForApproval: true }
        if (entry.id === independent.id) await new Promise<void>((resolve) => { releaseIndependent = resolve })
      },
      pollIntervalMs: 10_000,
    })

    await queue.dispatchOnce()
    await waitFor(() => store.getConversationQueueEntry(first.id)?.status === 'waiting-approval' && store.getConversationQueueEntry(independent.id)?.status === 'running')
    expect(store.getEmployee(employee.id)).toMatchObject({ presence: 'working', health: 'healthy' })
    expect(store.getConversationQueueEntry(followUp.id)?.status).toBe('queued')
    await queue.dispatchOnce()
    expect(seen).toEqual(expect.arrayContaining([first.id, independent.id]))
    expect(seen).not.toContain(followUp.id)
    expect(store.getConversationQueueEntry(followUp.id)?.status).toBe('queued')

    releaseIndependent?.()
    await waitFor(() => store.getConversationQueueEntry(independent.id)?.status === 'completed')
    expect(store.getEmployee(employee.id)).toMatchObject({ presence: 'working', health: 'healthy' })
    await queue.close()
  })

  it('recovers a queued group discussion after a full service restart', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-group-queue-restart-'))
    roots.push(stateRoot)
    const seed = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, runtime: new QueueRuntime(), bootstrapDefaultWorld: true })
    const workspace = seed.store.listWorkspaces()[0]!
    const world = seed.store.listWorlds(workspace.id)[0]!
    const employee = seed.store.listEmployees(world.id)[0]!
    const colleague = seed.store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'core.butler',
      blueprintVersion: 1,
      displayName: '重启协作角色',
    })
    const begun = seed.orchestrator.beginGroupQueued({
      workspaceId: workspace.id,
      worldId: world.id,
      employeeIds: [employee.id, colleague.id],
      prompt: '服务重启后继续这次群聊',
      collaborationMode: 'discussion',
      metadata: { clientTurnId: 'group-restart-turn' },
    })
    seed.store.enqueueConversationTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: begun.session.id,
      workTurnId: begun.workTurn.id,
      employeeIds: [employee.id, colleague.id],
      conversationKind: 'group',
      collaborationMode: 'discussion',
    })
    await seed.close()

    const runtime = new QueueRuntime()
    const recovered = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, runtime })
    servers.push(recovered)
    await recovered.start()
    await waitFor(() => recovered.store.getWorkTurn(begun.workTurn.id)?.status === 'completed')
    expect(recovered.store.listTurnAgentRuns(begun.workTurn.id)).toHaveLength(2)
    expect(runtime.calls).toHaveLength(2)
    expect(recovered.store.listMessages(begun.session.id).filter((message) => message.kind === 'user')).toHaveLength(1)
  })

  it('cancels a queued group follow-up and stops only the running group WorkTurn', async () => {
    const { origin, server, runtime, world, employee } = await start()
    const colleague = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'core.butler',
      blueprintVersion: 1,
      displayName: '群聊停止角色',
    })
    const running = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id, colleague.id],
      prompt: '请停止这个群聊长任务',
      collaborationMode: 'discussion',
      queueMode: 'normal',
      clientTurnId: 'group-running-stop',
    }))
    const followUp = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [employee.id, colleague.id],
      sessionId: running.body.session.id,
      prompt: '这条群聊消息必须保持排队',
      collaborationMode: 'discussion',
      queueMode: 'normal',
      clientTurnId: 'group-follow-up-cancel',
    }))
    await waitFor(() => server.store.getConversationQueueEntry(running.body.queueItem.id)?.status === 'running')
    const modeChange = await json(origin, `/api/sessions/${running.body.session.id}/collaboration-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collaborationMode: 'task' }),
    })
    expect(modeChange.response.status).toBe(409)
    expect(server.store.getConversationQueueEntry(followUp.body.queueItem.id)?.status).toBe('queued')
    const cancelled = await json(origin, `/api/worlds/${world.id}/chat-queue/${followUp.body.queueItem.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
    expect(cancelled.response.status).toBe(200)
    expect(server.store.getConversationQueueEntry(followUp.body.queueItem.id)?.status).toBe('cancelled')
    expect(server.store.getWorkTurn(followUp.body.workTurnId)?.status).toBe('interrupted')
    expect(server.store.listTurnAgentRuns(followUp.body.workTurnId)).toHaveLength(0)

    const stopped = await json(origin, `/api/turns/${running.body.workTurnId}/abort`, post({ reason: 'group-stop' }))
    expect(stopped.response.status).toBe(200)
    await waitFor(() => server.store.getConversationQueueEntry(running.body.queueItem.id)?.status === 'interrupted')
    expect(server.store.listTurnAgentRuns(running.body.workTurnId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'interrupted' })]),
    )
    expect(runtime.aborted.length).toBeGreaterThan(0)
  })
})

function testBlueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'queue.employee',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '队列角色',
    role: '测试角色',
    summary: '用于验证会话顺序',
    persona: '你负责验证队列顺序。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-26T00:00:00.000Z',
  }
}

function createDirectSession(store: SqliteStore, workspaceId: string, worldId: string, employeeId: string, title: string) {
  return store.createSession({
    workspaceId,
    worldId,
    kind: 'direct',
    title,
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employeeId, kind: 'employee' }],
  })
}

function enqueueStoredTurn(store: SqliteStore, workspaceId: string, worldId: string, sessionId: string, employeeId: string, content: string) {
  const turn = store.createWorkTurn({ workspaceId, worldId, sessionId, interactionKind: 'chat' })
  store.appendMessage({
    sessionId,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content,
    metadata: { workTurnId: turn.id, queueEmployeeId: employeeId },
    correlationId: sessionId,
  })
  return store.enqueueConversationTurn({
    workspaceId,
    worldId,
    sessionId,
    workTurnId: turn.id,
    employeeIds: [employeeId],
    conversationKind: 'direct',
  })
}
