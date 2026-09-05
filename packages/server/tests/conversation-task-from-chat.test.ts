import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, WorkTask, WorkTaskDetail, WorldTraceEntry } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'
import type { ConversationTaskIntentPort } from '../src/services/conversation-task-intent-classifier.js'
import { ServiceError } from '../src/services/service-error.js'

/**
 * The whole path the owner sees: one clear instruction in chat becomes one
 * editable task in the existing task list, an ordinary question becomes
 * nothing, and a classifier outage becomes nothing plus a visible failure —
 * while the conversation turn itself answers normally in every case.
 */

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class ChatRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    return { agentSessionId: `chat-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已回复。`, eventCount: 0 }
  }
  async close(): Promise<void> {}
}

/** Deterministic stand-in for the model classifier: CI never calls a cloud model. */
function stubIntent(answers: Record<string, unknown>): ConversationTaskIntentPort & { prompts: string[] } {
  const prompts: string[] = []
  return {
    prompts,
    async classify(input) {
      prompts.push(input.prompt)
      const answer = answers[input.prompt]
      if (answer instanceof Error) throw answer
      return answer as never
    },
  }
}

/**
 * A classifier that answers only when this test says so.
 *
 * The real one is a network call with an eight second ceiling. Holding it open
 * is how a test can tell "the send overlapped the decision" from "the send
 * waited for it" without measuring a clock.
 */
function gatedIntent(answer: unknown): ConversationTaskIntentPort & { release(): void; entered: Promise<void> } {
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  return {
    release,
    entered: started,
    async classify() {
      entered()
      await gate
      if (answer instanceof Error) throw answer
      return answer as never
    },
  }
}

/** Fails with the caller's own sentence instead of an anonymous suite timeout. */
async function answeredWithin<T>(pending: Promise<T>, milliseconds: number, complaint: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(complaint)), milliseconds) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Polls a read model until it says what the caller is waiting for. */
async function eventually<T>(read: () => T | undefined | Promise<T | undefined>, complaint: string, milliseconds = 5_000): Promise<T> {
  const deadline = Date.now() + milliseconds
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(complaint)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function start(intent: ConversationTaskIntentPort) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-chat-task-intent-'))
  roots.push(stateRoot)
  const runtime = new ChatRuntime()
  const server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, runtime, conversationTaskIntent: intent,
  })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  return { origin, server, runtime, workspace, world, employee }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { status: response.status, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

const INSTRUCTION = '把上周的用户反馈整理成一份改进清单，标出优先级。'
const QUESTION = '用户反馈一般多久处理一轮比较合适？'
const DISCUSSION = '我在想我们是不是该把反馈渠道再收一收，你觉得呢？'

describe('a chat instruction becomes one task in the task list', () => {
  it('records one editable draft, ignores a question and a discussion, and answers every turn', async () => {
    const intent = stubIntent({
      [INSTRUCTION]: { title: '整理用户反馈改进清单', description: '汇总上周用户反馈，按影响面排序，输出一份带优先级的改进清单。', priority: 'high' },
      [QUESTION]: undefined,
      [DISCUSSION]: undefined,
    })
    const { origin, server, world, employee } = await start(intent)

    const instructed = await json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: INSTRUCTION }))
    expect(instructed.status).toBe(200)
    // The turn still answers: the task is recorded beside the reply, not instead of it.
    expect(instructed.body.replies?.length ?? 0).toBeGreaterThan(0)
    expect(instructed.body.proposedTask).toMatchObject({
      title: '整理用户反馈改进清单', status: 'draft', priority: 'high', sourceWorkTurnId: instructed.body.workTurnId,
    })

    for (const chatter of [QUESTION, DISCUSSION]) {
      const reply = await json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: chatter }))
      expect(reply.status).toBe(200)
      expect(reply.body.proposedTask).toBeUndefined()
    }

    const listed = await json(origin, `/api/worlds/${world.id}/tasks`)
    expect(listed.status).toBe(200)
    expect((listed.body.items as WorkTask[]).map((task) => ({ title: task.title, status: task.status }))).toEqual([
      { title: '整理用户反馈改进清单', status: 'draft' },
    ])
    expect(intent.prompts).toEqual([INSTRUCTION, QUESTION, DISCUSSION])
    // Recording a task starts nothing: only the three conversation turns ran.
    expect(server.store.listTurnAgentRuns(instructed.body.workTurnId)).toHaveLength(1)
  })

  it('accepts a queued instruction without waiting for the decision, then records its task', async () => {
    const intent = gatedIntent({ title: '整理用户反馈改进清单', description: '汇总上周用户反馈，输出一份带优先级的改进清单。', priority: 'normal' })
    const { origin, server, world, employee } = await start(intent)

    // Enqueuing reserves a turn and returns. It does no model work of its own,
    // so it must not be charged for the classifier's — which is still inside
    // `classify` and will stay there until this test lets it out.
    const queued = await answeredWithin(
      json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: INSTRUCTION, queueMode: 'normal' })),
      2_000,
      '排队发送等待了意图判定才返回',
    )
    expect(queued.status).toBe(202)
    // Nothing decided yet, so the 202 carries no task. The panel learns about
    // it from the world-task event, the same way it learns about every other
    // task the host records behind an open list.
    expect(queued.body.proposedTask).toBeUndefined()
    expect(server.work.list(world.id)).toEqual([])
    expect(server.store.getWorkTurn(queued.body.workTurnId)?.status).not.toBe('completed')

    intent.release()
    const task = await eventually(() => server.work.list(world.id)[0], '排队指令的任务始终没有被记录')
    expect(task).toMatchObject({ status: 'draft', title: '整理用户反馈改进清单', sourceWorkTurnId: queued.body.workTurnId })
  })

  it('keeps a queued turn healthy and puts the failure on the trace when the decision fails late', async () => {
    const intent = gatedIntent(new ServiceError('unavailable', 'model_call_timeout', '模型响应超时。'))
    const { origin, server, world, employee } = await start(intent)
    const queued = await answeredWithin(
      json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: INSTRUCTION, queueMode: 'normal' })),
      2_000,
      '排队发送等待了意图判定才返回',
    )
    expect(queued.status).toBe(202)
    expect(queued.body.proposedTask).toBeUndefined()

    intent.release()
    const failure = await eventually(async () => {
      const trace = await json(origin, `/api/worlds/${world.id}/trace`)
      return (trace.body.items as WorldTraceEntry[]).find((entry) => entry.summary.includes('任务意图'))
    }, '判定失败没有出现在轨迹里')
    expect(failure.status).toBe('failed')
    expect(server.work.list(world.id)).toEqual([])
    // The turn the owner actually queued still ran and answered.
    const settled = await eventually(() => {
      const turn = server.store.getWorkTurn(queued.body.workTurnId)
      return turn?.status === 'completed' ? turn : undefined
    }, '排队的回合没有正常完成')
    expect(settled.errorCode).toBeUndefined()
  })

  it('runs the recorded task on an explicit action and keeps one task across execution, failure and restart', async () => {
    const intent = stubIntent({
      [INSTRUCTION]: { title: '整理用户反馈改进清单', description: '汇总上周用户反馈，按影响面排序，输出一份带优先级的改进清单。', priority: 'normal' },
    })
    const { origin, server, world, employee } = await start(intent)
    const instructed = await json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: INSTRUCTION }))
    const taskId = instructed.body.proposedTask.id as string
    const workTurnId = instructed.body.workTurnId as string

    const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'cyber-company.software-engineer', blueprintVersion: 1, displayName: '改进工程师', skillGrants: ['coding'],
    }))
    expect(recruited.status).toBe(201)
    const executed = await json(origin, `/api/tasks/${taskId}/execute`, post({
      employeeIds: [employee.id, recruited.body.employee.id], coordinatorEmployeeId: employee.id,
    }))
    expect(executed.status).toBe(200)
    expect((executed.body as WorkTaskDetail).task).toMatchObject({ id: taskId, status: 'waiting-review', currentPlanRevision: 1 })
    expect((executed.body as WorkTaskDetail).runs.at(-1)?.agentRunIds.length).toBeGreaterThan(0)

    // The same turn coming back — a resend, a retry, the pass after a restart —
    // resolves to the task that already exists instead of a second one.
    expect(server.work.createFromSource({
      worldId: world.id, workTurnId, title: '换个标题', description: '换个目标。',
    })).toMatchObject({ created: false, task: { id: taskId, status: 'waiting-review', title: '整理用户反馈改进清单' } })

    const reopened = await json(origin, `/api/worlds/${world.id}/tasks`)
    expect((reopened.body.items as WorkTask[]).map((task) => task.id)).toEqual([taskId])
  })

  it('leaves no task and no broken turn when the classifier times out, is rate limited or answers with nonsense', async () => {
    const outages = [
      new ServiceError('unavailable', 'model_call_timeout', '模型响应超时。'),
      new ServiceError('rate-limited', 'work_task_intent_rate_limited', '模型限流。', 429),
      new ServiceError('unavailable', 'model_call_response_invalid', '模型没有返回可解析的 JSON。'),
    ]
    const { origin, world, employee } = await start({
      async classify() { throw outages.shift() ?? new Error('unexpected extra classification') },
    })

    for (const attempt of [0, 1, 2]) {
      const answered = await json(origin, `/api/worlds/${world.id}/chat`, post({ employeeIds: [employee.id], prompt: `${INSTRUCTION}（第 ${attempt} 次）` }))
      expect(answered.status).toBe(200)
      expect(answered.body.replies?.length ?? 0).toBeGreaterThan(0)
      expect(answered.body.proposedTask).toBeUndefined()
    }

    const listed = await json(origin, `/api/worlds/${world.id}/tasks`)
    expect(listed.body.items).toEqual([])
    // The failure is where every other execution failure already is: the trace.
    const trace = await json(origin, `/api/worlds/${world.id}/trace`)
    const failures = (trace.body.items as WorldTraceEntry[]).filter((entry) => entry.summary.includes('任务意图'))
    expect(failures).toHaveLength(3)
    expect(failures.every((entry) => entry.status === 'failed')).toBe(true)
  })
})
