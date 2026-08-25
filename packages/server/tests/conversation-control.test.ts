import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class QueueRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  readonly aborted: string[] = []
  #pending = new Map<string, { reject: (error: unknown) => void }>()

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
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
    expect(runtime.aborted).toHaveLength(1)
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
})
