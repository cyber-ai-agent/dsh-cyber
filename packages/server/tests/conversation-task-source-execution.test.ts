import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, WorkTaskDetail } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'
import type { ConversationTaskIntentPort } from '../src/services/conversation-task-intent-classifier.js'

/**
 * What a draft says about the turn that asked for it.
 *
 * A conversation turn records a task and then goes on to run: it answers, or
 * it fails, or it is still sitting in the queue. The task is a draft the whole
 * time, because a classification is not permission to execute anything. But
 * "still a draft" must not read as "nothing ever happened" — the owner has to
 * be able to see the turn their instruction actually produced, and tell it
 * apart from the task's own execution, which has not begun.
 */

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const INSTRUCTION = '把上周的用户反馈整理成一份改进清单，标出优先级。'
const PROPOSAL = { title: '整理用户反馈改进清单', description: '汇总上周用户反馈，按影响面排序，输出一份带优先级的改进清单。', priority: 'high' as const }

/** Deterministic stand-in for the model classifier: CI never calls a cloud model. */
const intent: ConversationTaskIntentPort = {
  async classify(input) { return input.prompt === INSTRUCTION ? PROPOSAL : undefined },
}

class ChatRuntime implements AgentRuntimePort {
  readonly #gate: Promise<void> | undefined
  release: () => void = () => {}
  constructor(held = false) {
    if (held) this.#gate = new Promise<void>((resolve) => { this.release = resolve })
  }
  async runTurn(request: AgentTurnRequest) {
    await this.#gate
    return { agentSessionId: `chat-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已回复。`, eventCount: 0 }
  }
  async close(): Promise<void> {}
}

async function start(runtime: AgentRuntimePort) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-task-source-'))
  roots.push(stateRoot)
  const server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, runtime, conversationTaskIntent: intent,
  })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  return { origin, server, world, employee }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { status: response.status, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, complaint: string, milliseconds = 5_000): Promise<T> {
  const deadline = Date.now() + milliseconds
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(complaint)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Reads the world SSE the open task panel subscribes to. */
async function watchWorldEvents(origin: string, worldId: string): Promise<{ count(kind: string): number; stop(): void }> {
  const controller = new AbortController()
  const response = await fetch(`${origin}/api/worlds/${worldId}/live`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
  const kinds: string[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done || chunk.value === undefined) return
        for (const line of decoder.decode(chunk.value, { stream: true }).split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const envelope = JSON.parse(line.slice(5).trim()) as { kind?: unknown }
            if (typeof envelope.kind === 'string') kinds.push(envelope.kind)
          } catch { /* keep-alive lines are not JSON. */ }
        }
      }
    } catch { /* The stream ends when the test stops watching or the server closes. */ }
  })()
  return { count: (kind) => kinds.filter((item) => item === kind).length, stop: () => controller.abort() }
}

describe('a draft is linked to the execution of its source turn', () => {
  it('shows the finished source turn and its runs while the task itself has still run nothing', async () => {
    const { origin, world, employee } = await start(new ChatRuntime())
    const instructed = await json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: INSTRUCTION }))
    expect(instructed.status).toBe(200)

    const detail = (await json(origin, `/api/tasks/${instructed.body.proposedTask.id}`)).body as WorkTaskDetail
    expect(detail.task.status).toBe('draft')
    // The task's own execution list stays empty: a draft has never run, and
    // the source turn is not an attempt at it.
    expect(detail.runs).toEqual([])
    expect(detail.sourceTurn).toMatchObject({
      workTurnId: instructed.body.workTurnId,
      sessionId: instructed.body.session.id,
      status: 'completed',
    })
    expect(detail.sourceTurn?.runs).toHaveLength(1)
    expect(detail.sourceTurn?.runs[0]).toMatchObject({ employeeId: employee.id, status: 'completed' })
    expect(detail.sourceTurn?.runs[0]?.completedAt).toEqual(expect.any(String))
  })

  it('follows a queued source turn from queued to completed and wakes the open list when it settles', async () => {
    const runtime = new ChatRuntime(true)
    const { origin, server, world, employee } = await start(runtime)
    const watch = await watchWorldEvents(origin, world.id)
    try {
      const queued = await json(origin, `/api/worlds/${world.id}/chat`, post({
        employeeIds: [employee.id], prompt: INSTRUCTION, queueMode: 'normal',
      }))
      expect(queued.status).toBe(202)

      const task = await eventually(() => server.work.list(world.id)[0], '排队指令的任务始终没有被记录')
      const waiting = (await json(origin, `/api/tasks/${task.id}`)).body as WorkTaskDetail
      // Held by the runtime: the turn has not answered yet, and the draft says
      // exactly that instead of showing nothing.
      expect(waiting.sourceTurn?.workTurnId).toBe(queued.body.workTurnId)
      expect(['queued', 'running']).toContain(waiting.sourceTurn?.status)
      const announced = await eventually(() => watch.count('world-task') > 0 ? watch.count('world-task') : undefined, '记录任务时没有唤醒任务列表')

      runtime.release()
      await eventually(() => server.store.getWorkTurn(queued.body.workTurnId)?.status === 'completed' ? true : undefined, '排队的回合没有完成')
      // The open panel is told the row changed, so it re-reads the truth it is
      // already displaying rather than showing "排队中" until someone reloads.
      await eventually(() => watch.count('world-task') > announced ? true : undefined, '源回合结束后没有再唤醒任务列表')

      const settled = (await json(origin, `/api/tasks/${task.id}`)).body as WorkTaskDetail
      expect(settled.sourceTurn).toMatchObject({ workTurnId: queued.body.workTurnId, status: 'completed' })
      expect(settled.sourceTurn?.runs).toHaveLength(1)
      // Its turn ran, answered and finished. The task did not move: only the
      // owner may start it.
      expect(settled.task.status).toBe('draft')
      expect(settled.runs).toEqual([])
    } finally {
      runtime.release()
      watch.stop()
    }
  })

  it('carries no source execution for a task the owner created on the board', async () => {
    const { origin, world } = await start(new ChatRuntime())
    const created = await json(origin, `/api/worlds/${world.id}/tasks`, post({
      title: '手工任务', description: '在看板上直接创建的任务。', priority: 'normal',
    }))
    expect(created.status).toBe(201)
    const detail = (await json(origin, `/api/tasks/${created.body.task.id}`)).body as WorkTaskDetail
    expect(detail.sourceTurn).toBeUndefined()
  })
})
