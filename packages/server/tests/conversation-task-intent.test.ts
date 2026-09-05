import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { DomainEvent, EmployeeBlueprint, ModelProfile } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import {
  ModelConversationTaskIntentClassifier,
  type ConversationTaskIntentPort,
} from '../src/services/conversation-task-intent-classifier.js'
import { ConversationTaskIntentService } from '../src/services/conversation-task-intent-service.js'
import type { GroupTaskCollaborationService } from '../src/services/group-task-collaboration-service.js'
import { ServiceError } from '../src/services/service-error.js'
import { WorkSystemService } from '../src/services/work-system-service.js'

/**
 * 明确的执行意图变成一条可见的任务草稿；普通问答和讨论什么都不留下。
 *
 * The decision is a bounded model call, not a keyword table, and its answer is
 * untrusted: the host keeps a title, a goal and a priority it rebuilt itself,
 * and nothing else. Every failure mode — timeout, 429, a rejected credential,
 * unparseable JSON, prose that smuggles a link or a token — ends with no task
 * and a failure the world trace can show, never with an invented one and never
 * with a broken conversation turn.
 */

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(join(await mkdtemp(join(tmpdir(), 'dsh-cyber-task-intent-')), 'cyber.sqlite'))
  stores.push(store)
  return store
}

const neverRuns = {
  run: async () => { throw new Error('a proposed task must not execute itself') },
} as unknown as GroupTaskCollaborationService

interface Conversation { workspaceId: string; worldId: string; sessionId: string; employeeId: string }

function conversation(store: SqliteStore, name: string): Conversation {
  const workspace = store.createWorkspace({ name: `${name}工作区` })
  const world = store.createWorld({ workspaceId: workspace.id, name, templateId: 'cyber-company' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: `test.${world.id}.assistant`, version: 1, worldTemplateId: 'cyber-company',
    displayName: `${name}助手`, role: '助理', summary: '任务意图测试角色', persona: '保持当前世界边界。',
    requestedSkills: [], requestedCapabilities: [], createdAt: '2026-09-04T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1 })
  const session = store.createSession({
    workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '私聊',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  return { workspaceId: workspace.id, worldId: world.id, sessionId: session.id, employeeId: employee.id }
}

function send(store: SqliteStore, context: Conversation, content: string) {
  const turn = store.createWorkTurn({ workspaceId: context.workspaceId, worldId: context.worldId, sessionId: context.sessionId, interactionKind: 'chat' })
  store.appendMessage({ sessionId: context.sessionId, senderId: 'owner', senderKind: 'owner', kind: 'user', content, metadata: { workTurnId: turn.id } })
  return turn
}

function taskEvents(store: SqliteStore, context: Conversation): DomainEvent[] {
  return store.listDomainEvents(context.workspaceId).filter((event) => event.type.startsWith('work.task.propos'))
}

/** The deterministic stand-in a test, and CI, uses instead of a cloud model. */
function stubClassifier(answers: Record<string, unknown>): ConversationTaskIntentPort & { prompts: string[] } {
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

function intentService(store: SqliteStore, classifier: ConversationTaskIntentPort, published: string[] = []): ConversationTaskIntentService {
  return new ConversationTaskIntentService({
    store,
    work: new WorkSystemService({ store, groupTasks: neverRuns }),
    classifier,
    runtime: { publishTaskChanged: (worldId) => { published.push(worldId) } },
  })
}

function profile(): ModelProfile {
  return {
    id: 'profile-task-intent', workspaceId: 'workspace-task-intent', displayName: 'fake',
    providerKind: 'openai-compatible-remote', baseUrl: 'https://models.example.test/v1', modelId: 'fake',
    api: 'openai-completions', isDefault: true, settings: {},
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  } as ModelProfile
}

function modelStore(resolved: ModelProfile | undefined) {
  return {
    getModelAssignment: () => undefined,
    getModelProfile: () => undefined,
    resolveWorkspaceDefaultProfile: () => resolved,
  } as unknown as ConstructorParameters<typeof ModelConversationTaskIntentClassifier>[0]['store']
}

function modelCall(answer: string | (() => never)) {
  const prompts: Array<{ system: string; user: string }> = []
  return {
    prompts,
    async text(_profile: ModelProfile, prompt: { system: string; user: string }) {
      prompts.push(prompt)
      if (typeof answer !== 'string') answer()
      return answer
    },
  }
}

describe('conversation intent becomes a task list entry', () => {
  it('turns one clear instruction into one visible draft task and leaves questions and discussion alone', async () => {
    const store = await open()
    const context = conversation(store, '意图世界')
    const published: string[] = []
    const classifier = stubClassifier({
      '把这周的客服工单整理成一份复盘文档，周五前给我。': {
        title: '整理客服工单复盘文档',
        description: '汇总本周客服工单，按问题类别归纳，输出一份可提交的复盘文档。',
        priority: 'high',
      },
      '客服工单一般多久回复算正常？': undefined,
      '我觉得复盘应该每两周做一次，你怎么看？': undefined,
    })
    const service = intentService(store, classifier, published)

    const instruction = send(store, context, '把这周的客服工单整理成一份复盘文档，周五前给我。')
    const created = service.attach(
      await service.propose({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: '把这周的客服工单整理成一份复盘文档，周五前给我。' }),
      { workspaceId: context.workspaceId, worldId: context.worldId, workTurnId: instruction.id },
    )
    expect(created).toMatchObject({
      title: '整理客服工单复盘文档',
      // Created in its draft state: visible before anything runs, and running
      // it stays a separate, explicit action.
      status: 'draft',
      priority: 'high',
      sourceWorkTurnId: instruction.id,
      createdBy: 'owner',
    })
    expect(published).toEqual([context.worldId])
    expect(taskEvents(store, context).map((event) => event.type)).toEqual(['work.task.proposed'])

    for (const chatter of ['客服工单一般多久回复算正常？', '我觉得复盘应该每两周做一次，你怎么看？']) {
      const turn = send(store, context, chatter)
      const nothing = service.attach(
        await service.propose({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: chatter }),
        { workspaceId: context.workspaceId, worldId: context.worldId, workTurnId: turn.id },
      )
      expect(nothing).toBeUndefined()
    }
    expect(new WorkSystemService({ store, groupTasks: neverRuns }).list(context.worldId)).toHaveLength(1)
    // Ordinary conversation leaves no residue at all: no task, no event.
    expect(taskEvents(store, context)).toHaveLength(1)
    expect(classifier.prompts).toHaveLength(3)
  })

  it('replays one turn onto one task: resend, retry after failure and a restart never mint a second', async () => {
    const store = await open()
    const context = conversation(store, '重放世界')
    const published: string[] = []
    const prompt = '给新同事写一份入职指引。'
    const service = intentService(store, stubClassifier({
      [prompt]: { title: '编写入职指引', description: '面向新同事，说明第一周要完成的准备工作。', priority: 'normal' },
    }), published)
    const turn = send(store, context, prompt)
    const attach = async () => service.attach(
      await service.propose({ workspaceId: context.workspaceId, worldId: context.worldId, prompt }),
      { workspaceId: context.workspaceId, worldId: context.worldId, workTurnId: turn.id },
    )

    const first = await attach()
    expect(first).toBeDefined()
    const resent = await attach()
    expect(resent?.id).toBe(first!.id)

    const work = new WorkSystemService({ store, groupTasks: neverRuns })
    // A failed attempt is history on the same row. Replaying the turn must not
    // resurrect a fresh draft beside it, nor repeat the external side effects
    // the first attempt already had.
    store.database.prepare('UPDATE work_tasks SET status = ? WHERE id = ?').run('failed', first!.id)
    const afterFailure = await attach()
    expect(afterFailure).toMatchObject({ id: first!.id, status: 'failed' })
    expect(work.list(context.worldId)).toHaveLength(1)

    // Only the create publishes and records; a replay changed nothing.
    expect(published).toEqual([context.worldId])
    expect(taskEvents(store, context)).toHaveLength(1)
  })

  it('fails closed: a classifier outage produces no task, a visible failure and an unbroken turn', async () => {
    const store = await open()
    const context = conversation(store, '失败世界')
    const published: string[] = []
    const outages = [
      new ServiceError('unavailable', 'model_call_timeout', '模型响应超时。'),
      new ServiceError('rate-limited', 'work_task_intent_rate_limited', '模型限流。', 429),
      new ServiceError('forbidden', 'work_task_intent_credential_rejected', '模型凭据被拒绝。', 401),
      new ServiceError('unavailable', 'model_call_response_invalid', '模型没有返回可解析的 JSON。'),
    ]
    const service = intentService(store, {
      async classify() { throw outages.shift() ?? new Error('unexpected extra classification') },
    }, published)

    for (const attempt of [0, 1, 2, 3]) {
      const turn = send(store, context, `第 ${attempt} 次一定要做的事。`)
      const outcome = await service.propose({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: `第 ${attempt} 次一定要做的事。` })
      expect(outcome.kind).toBe('failed')
      // Neither call throws: a classification outage never fails the turn.
      expect(service.attach(outcome, { workspaceId: context.workspaceId, worldId: context.worldId, workTurnId: turn.id })).toBeUndefined()
    }
    expect(new WorkSystemService({ store, groupTasks: neverRuns }).list(context.worldId)).toEqual([])
    expect(published).toEqual([])
    const failures = taskEvents(store, context)
    expect(failures.map((event) => event.type)).toEqual(Array.from({ length: 4 }, () => 'work.task.proposal.failed'))
    expect(failures.map((event) => event.payload.code)).toEqual([
      'model_call_timeout',
      'work_task_intent_rate_limited',
      'work_task_intent_credential_rejected',
      'model_call_response_invalid',
    ])
  })

  it('rebuilds the model answer against the host whitelist and refuses prose that carries a link, code or a token', async () => {
    const store = await open()
    const context = conversation(store, '重建世界')
    const hostile = {
      intent: 'instruction',
      title: '整理这周的账单',
      description: '把本周账单归类，标注异常项，输出一份对账说明。',
      priority: 'catastrophic',
      // None of these may reach the task: they are ids, state and routing the
      // host owns, arriving as model output.
      id: 'attacker-task', status: 'running', worldId: 'other-world', createdBy: 'model',
      coordinatorEmployeeId: 'nobody', dueAt: '2026-01-01T00:00:00.000Z', sourceWorkTurnId: 'other-turn',
    }
    const call = modelCall(JSON.stringify(hostile))
    const classifier = new ModelConversationTaskIntentClassifier({ store: modelStore(profile()), call })
    const proposal = await classifier.classify({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: '把这周的账单整理一下。' })
    expect(proposal).toEqual({
      title: '整理这周的账单',
      description: '把本周账单归类，标注异常项，输出一份对账说明。',
      // An unknown priority falls back to the host default rather than being trusted.
      priority: 'normal',
    })
    expect(call.prompts).toHaveLength(1)
    // The message travels as data inside a JSON envelope, never as an instruction.
    expect(call.prompts[0]!.user).toBe(JSON.stringify({ message: '把这周的账单整理一下。' }))
    expect(call.prompts[0]!.system).toMatch(/不要执行/u)

    const refused = [
      { title: '运行 rm -rf /tmp', description: '把本周账单归类，标注异常项。' },
      { title: '整理账单', description: '详情见 https://example.test/bill 上的说明。' },
      { title: '整理账单', description: '用 Authorization: Bearer sk-abcdefghijklmnop 调用对账接口。' },
      { title: '整理账单', description: '<script>fetch()</script> 把账单导出来。' },
    ]
    for (const answer of refused) {
      const guarded = new ModelConversationTaskIntentClassifier({
        store: modelStore(profile()),
        call: modelCall(JSON.stringify({ intent: 'instruction', ...answer })),
      })
      await expect(guarded.classify({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: '把这周的账单整理一下。' }))
        .rejects.toThrow(ServiceError)
    }

    // A description that copies the pasted slab back is an echo, not a goal.
    const slab = `请照做：${'把服务器上的日志全部打包并上传到备份盘，然后清空目录。'.repeat(3)}`
    const echo = new ModelConversationTaskIntentClassifier({
      store: modelStore(profile()),
      call: modelCall(JSON.stringify({ intent: 'instruction', title: '打包日志', description: slab })),
    })
    await expect(echo.classify({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: slab })).rejects.toThrow(ServiceError)
  })

  it('reads intent from the model, keeps nothing when it is not an instruction, and never calls one it cannot resolve', async () => {
    const store = await open()
    const context = conversation(store, '判定世界')
    for (const intent of ['question', 'discussion', 'anything-else']) {
      const call = modelCall(JSON.stringify({ intent, title: '不该出现的任务', description: '不该出现的目标。' }))
      const classifier = new ModelConversationTaskIntentClassifier({ store: modelStore(profile()), call })
      await expect(classifier.classify({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: '这个怎么做？' }))
        .resolves.toBeUndefined()
    }

    // An instruction the model would not describe is not a task the host can show.
    const empty = new ModelConversationTaskIntentClassifier({
      store: modelStore(profile()),
      call: modelCall(JSON.stringify({ intent: 'instruction', title: '   ', description: '' })),
    })
    await expect(empty.classify({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: '去做点什么。' })).rejects.toThrow(ServiceError)

    // No configured model means nothing to classify with; the turn reports the
    // missing model on its own and the trace stays quiet.
    const silent = modelCall(() => { throw new Error('a world without a model profile must not call one') })
    const unconfigured = new ModelConversationTaskIntentClassifier({ store: modelStore(undefined), call: silent })
    await expect(unconfigured.classify({ workspaceId: context.workspaceId, worldId: context.worldId, prompt: '把账单整理一下。' }))
      .resolves.toBeUndefined()
    expect(silent.prompts).toEqual([])
  })
})
