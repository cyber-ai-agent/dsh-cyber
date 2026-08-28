import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeBlueprint,
} from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { ConversationOrchestrator } from '../src/index.js'

const stores: SqliteStore[] = []
const orchestrators: ConversationOrchestrator[] = []

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.close()
  for (const store of stores.splice(0)) store.close()
})

class FakeRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  readonly responses: Record<string, string>

  constructor(responses: Record<string, string>) {
    this.responses = responses
  }

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    const content = this.responses[request.agent.id] ?? `reply:${request.agent.displayName}`
    const sessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    for (const event of runtimeEvents(sessionId, content)) request.onEvent?.(event)
    return { agentSessionId: sessionId, finalResponse: content, eventCount: 6 }
  }

  async close(): Promise<void> {}
}

class AbortableRuntime implements AgentRuntimePort {
  workTurnId: string | undefined
  agentRunId: string | undefined
  readonly abortedRunIds: string[] = []
  #startedResolve: (() => void) | undefined
  #runReject: ((error: unknown) => void) | undefined

  async runTurn(request: AgentTurnRequest): Promise<never> {
    this.workTurnId = request.workTurnId
    this.agentRunId = request.agentRunId
    this.#startedResolve?.()
    return await new Promise<never>((_resolve, reject) => { this.#runReject = reject })
  }

  async abortRun(agentRunId: string): Promise<void> {
    this.abortedRunIds.push(agentRunId)
    this.#runReject?.(new Error('runtime aborted'))
  }

  async waitUntilStarted(): Promise<void> {
    if (this.agentRunId !== undefined) return
    await new Promise<void>((resolve) => { this.#startedResolve = resolve })
  }

  async close(): Promise<void> {}
}

function runtimeEvents(sessionId: string, content: string): AgentRuntimeEvent[] {
  return [
    {
      kind: 'turn.started',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 1,
      metadata: {},
    },
    {
      kind: 'reasoning.delta',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 2,
      content: 'stream-only',
      metadata: {},
    },
    {
      kind: 'assistant.reasoning',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 3,
      content: '先核对事实。',
      metadata: {},
    },
    {
      kind: 'tool.started',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 4,
      toolName: 'search_docs',
      callId: 'call-1',
      metadata: {},
    },
    {
      kind: 'tool.completed',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 5,
      callId: 'call-1',
      failed: false,
      metadata: {},
    },
    {
      kind: 'assistant.message',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 6,
      content,
      metadata: {},
    },
    {
      kind: 'turn.completed',
      source: 'test-runtime',
      sourceSessionId: sessionId,
      sourceSequence: 7,
      metadata: {},
    },
  ]
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-orchestration-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const company = store.createWorld({
    workspaceId: workspace.id,
    name: '赛博公司',
    templateId: 'cyber-company',
  })
  const tavern = store.createWorld({
    workspaceId: workspace.id,
    name: '月影酒馆',
    templateId: 'tavern',
  })
  return { directory, store, workspace, company, tavern }
}

function blueprint(
  id: string,
  displayName: string,
  role: string,
  worldTemplateId = 'cyber-company',
): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId,
    displayName,
    role,
    summary: `${role}角色`,
    persona: `你是${displayName}，只以自己的身份发言。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

describe('ConversationOrchestrator', () => {
  it('keeps a direct agent session persistent and streams facts separately from durable messages', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('engineer', '小刘', '软件工程师'))
    const employee = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const runtime = new FakeRuntime({ [employee.id]: '我会先建立性能基线。' })
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)
    const realtime: AgentRuntimeEvent[] = []
    const realtimeIds: Array<{ workTurnId: string; agentRunId: string; traceTurnId: unknown }> = []
    const durableAtEmit: Array<{ kind: AgentRuntimeEvent['kind']; persisted: boolean }> = []
    orchestrator.subscribe((event) => {
      realtime.push(event.event)
      realtimeIds.push({ workTurnId: event.workTurnId, agentRunId: event.agentRunId, traceTurnId: event.event.metadata.traceTurnId })
      const eventTypes = store.listWorldDomainEvents(company.id).map((item) => item.type)
      const messages = store.listMessages(event.sessionId)
      const persisted = event.event.kind === 'turn.started'
        ? eventTypes.includes('turn.started')
        : event.event.kind === 'tool.started'
          ? eventTypes.includes('tool.started') && messages.some((message) => message.kind === 'tool-call')
          : event.event.kind === 'assistant.message'
            ? messages.some((message) => message.kind === 'assistant' && message.content === event.event.content)
            : event.event.kind === 'turn.completed'
              ? eventTypes.includes('turn.completed')
              : true
      durableAtEmit.push({ kind: event.event.kind, persisted })
    })

    const first = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: employee.id,
      prompt: '检查登录性能',
      metadata: { clientTurnId: 'client-turn-direct', modelProfileId: 'temporary-model' },
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: employee.id,
      sessionId: first.session.id,
      prompt: '继续给出验收标准',
      metadata: { clientTurnId: 'client-turn-direct' },
    })

    expect(runtime.calls).toHaveLength(2)
    expect(runtime.calls[0]?.modelProfileId).toBe('temporary-model')
    expect(runtime.calls[1]?.modelProfileId).toBeUndefined()
    expect(store.getEmployee(employee.id)?.agentSessionId).toBe(`agent-${employee.id}`)
    expect(realtime.some((event) => event.kind === 'reasoning.delta')).toBe(true)
    expect(realtime.every((event) => event.metadata.clientTurnId === 'client-turn-direct')).toBe(true)
    expect(durableAtEmit
      .filter((item) => ['turn.started', 'tool.started', 'turn.completed'].includes(item.kind))
      .every((item) => item.persisted)).toBe(true)
    expect(durableAtEmit.filter((item) => item.kind === 'assistant.message').some((item) => !item.persisted)).toBe(true)
    expect(store.listMessages(first.session.id).some((message) => message.content === 'stream-only')).toBe(
      false,
    )
    expect(
      store.listMessages(first.session.id).filter((message) => message.kind === 'assistant'),
    ).toHaveLength(2)
    expect(store.listWorldDomainEvents(company.id).at(-1)?.type).toBe('task.completed')
    expect(store.getEmployee(employee.id)?.status).toBe('available')
    const directTurns = store.listSessionTurns(first.session.id)
    expect(directTurns).toHaveLength(2)
    expect(directTurns.every((turn) => turn.status === 'completed')).toBe(true)
    expect(store.listTurnAgentRuns(directTurns[0]!.id)).toHaveLength(1)
    expect(realtimeIds.every((item) => item.agentRunId === item.traceTurnId && item.workTurnId.length > 0)).toBe(true)
    expect(store.listMessages(first.session.id).every((message) => message.metadata.workTurnId !== undefined)).toBe(true)
  })

  it('runs the addressed characters concurrently and keeps every speaker identifiable', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('tech-lead', '老王', '技术经理'))
    store.saveBlueprint(blueprint('engineer', '小刘', '软件工程师'))
    const lead = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'tech-lead',
      blueprintVersion: 1,
    })
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const runtime = new FakeRuntime({
      [lead.id]: '先建立监控基线，再决定改动范围。',
      [engineer.id]: '同意先量化，我补充数据库慢查询与缓存命中率。',
    })
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const result = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [lead.id, engineer.id],
      prompt: '讨论登录性能优化方案',
    })

    expect(result.replies.map((reply) => reply.employeeId).sort()).toEqual([lead.id, engineer.id].sort())
    expect(runtime.calls.map((call) => call.agent.id).sort()).toEqual([lead.id, engineer.id].sort())
    // Nobody was addressed, so the room answers as one concurrent wave: the
    // meeting costs one model latency instead of two, and neither character
    // sees the other's statement of this round. They meet in the next one,
    // through the durable transcript.
    expect(runtime.calls.every((call) => call.prompt.includes('尚无其他角色发言。'))).toBe(true)
    expect(store.listMessages(result.session.id).filter((message) => message.kind === 'assistant')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ senderId: lead.id }),
        expect.objectContaining({ senderId: engineer.id }),
      ]),
    )
    const eventTypes = store.listWorldDomainEvents(company.id).map((event) => event.type)
    expect(eventTypes).toContain('meeting.started')
    expect(eventTypes).toContain('meeting.finished')
    const [turn] = store.listSessionTurns(result.session.id)
    expect(turn).toMatchObject({ status: 'completed', interactionKind: 'meeting' })
    expect(store.listTurnAgentRuns(turn!.id)).toEqual([
      expect.objectContaining({ employeeId: lead.id, ordinal: 1, status: 'completed' }),
      expect.objectContaining({ employeeId: engineer.id, ordinal: 2, status: 'completed' }),
    ])
  })

  it('persists a task plan, executes dependent steps, and asks the coordinator for a real summary AgentRun', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('researcher', '小刘', '网络研究员'))
    store.saveBlueprint(blueprint('frontend', '老王', '前端工程师'))
    store.saveBlueprint(blueprint('story', '小陈', '故事作者'))
    const researcher = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'researcher', blueprintVersion: 1 })
    const frontend = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'frontend', blueprintVersion: 1 })
    const story = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'story', blueprintVersion: 1 })
    const runtime = new FakeRuntime({
      [researcher.id]: '官网资料已核对，保留来源。',
      [frontend.id]: '根据资料完成 HTML 对比页。',
      [story.id]: '不应执行。',
    })
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const result = await orchestrator.task({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [researcher.id, frontend.id, story.id],
      coordinatorEmployeeId: researcher.id,
      prompt: '查官网并制作 HTML 对比页',
      runtimePrompt: '请完成任务协作。',
      steps: [
        { id: 'research', ordinal: 1, requiredSkills: ['web.search'], assignedEmployeeIds: [researcher.id], dependsOn: [], executionMode: 'parallel' },
        { id: 'build', ordinal: 2, requiredSkills: ['coding'], assignedEmployeeIds: [frontend.id], dependsOn: ['research'], executionMode: 'sequential' },
      ],
    })

    expect(result.collaborationMode).toBe('task')
    expect(result.plan.status).toBe('completed')
    expect(result.plan.steps.map((step) => step.status)).toEqual(['completed', 'completed'])
    expect(result.replies.map((reply) => reply.employeeId)).toEqual([researcher.id, frontend.id, researcher.id])
    expect(runtime.calls.some((call) => call.agent.id === story.id)).toBe(false)
    expect(runtime.calls.find((call) => call.agent.id === frontend.id)?.prompt).toContain('官网资料已核对')
    expect(store.getSession(result.session.id)?.collaborationMode).toBe('task')
    expect(store.getTaskCollaborationPlan(result.plan.id)).toMatchObject({ status: 'completed', workTurnId: result.workTurnId })
    expect(store.listTurnAgentRuns(result.workTurnId)).toHaveLength(3)
  })

  it('continues an existing group history without creating a duplicate session', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('tech-lead', '老王', '技术经理'))
    store.saveBlueprint(blueprint('engineer', '小刘', '软件工程师'))
    const lead = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'tech-lead',
      blueprintVersion: 1,
    })
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const runtime = new FakeRuntime({})
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const first = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [lead.id, engineer.id],
      prompt: '第一次讨论',
      title: '发布协作群',
    })
    const second = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [lead.id, engineer.id],
      sessionId: first.session.id,
      prompt: '继续讨论验收',
    })

    expect(second.session.id).toBe(first.session.id)
    expect(store.listSessions(company.id).filter((session) => session.kind === 'group')).toHaveLength(1)
    expect(store.listMessages(first.session.id).filter((message) => message.kind === 'user')).toHaveLength(2)
    expect(store.listWorldDomainEvents(company.id).filter((event) => event.type === 'meeting.started')).toHaveLength(2)
  })

  it('atomically commits replies and durable completion jobs for direct, group, and peer AgentRuns', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('completion-a', '甲', '分析师'))
    store.saveBlueprint(blueprint('completion-b', '乙', '工程师'))
    const first = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'completion-a', blueprintVersion: 1 })
    const second = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'completion-b', blueprintVersion: 1 })
    const runtime = new FakeRuntime({ [first.id]: '甲的交付', [second.id]: '乙的交付' })
    let wakeCount = 0
    const orchestrator = new ConversationOrchestrator({
      store,
      runtime,
      workspacePath: directory,
      completionJobType: 'test-publication',
      onCompletionJobQueued: () => { wakeCount += 1 },
    })
    orchestrators.push(orchestrator)

    const direct = await orchestrator.direct({ workspaceId: workspace.id, worldId: company.id, employeeId: first.id, prompt: '直接交付' })
    const group = await orchestrator.group({ workspaceId: workspace.id, worldId: company.id, employeeIds: [first.id, second.id], prompt: '群组交付' })
    const peer = await orchestrator.peer({ workspaceId: workspace.id, worldId: company.id, initiatorId: first.id, participantIds: [second.id], purpose: '协作交付' })

    const completionJobs = store.listCompletionJobs(company.id)
    expect(completionJobs).toHaveLength(5)
    expect(completionJobs.every((job) => job.status === 'pending' && job.type === 'test-publication')).toBe(true)
    expect(completionJobs.every((job) => job.payload.workspacePath === directory)).toBe(true)
    expect(wakeCount).toBe(5)
    for (const session of [direct.session, group.session, peer.session]) {
      const assistantMessages = store.listMessages(session.id).filter((message) => message.kind === 'assistant')
      expect(assistantMessages.length).toBeGreaterThan(0)
      expect(assistantMessages.every((message) => message.metadata.completionStatus === 'pending')).toBe(true)
    }
    expect(completionJobs.every((job) => store.getAgentRun(job.agentRunId)?.status === 'completed')).toBe(true)
    expect(store.listMessages(group.session.id).filter((message) => message.kind === 'assistant')).toHaveLength(2)
    expect(store.listMessages(peer.session.id).filter((message) => message.kind === 'assistant')).toHaveLength(2)
  })

  it('preserves completed runs when a later group agent fails', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('lead-partial', '老王', '技术经理'))
    store.saveBlueprint(blueprint('engineer-partial', '小刘', '软件工程师'))
    const lead = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'lead-partial', blueprintVersion: 1 })
    const engineer = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'engineer-partial', blueprintVersion: 1 })
    let calls = 0
    const runtime: AgentRuntimePort = {
      async runTurn(request) {
        calls += 1
        if (calls === 2) throw new Error('runtime unavailable')
        request.onEvent?.({ kind: 'assistant.message', source: 'partial-test', sourceSessionId: 'first-run', content: '第一位已完成。', metadata: {} })
        return { agentSessionId: 'first-run', finalResponse: '第一位已完成。', eventCount: 1 }
      },
      async close() {},
    }
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const result = await orchestrator.group({
      workspaceId: workspace.id, worldId: company.id, employeeIds: [lead.id, engineer.id], prompt: '执行两步检查',
    })

    // One character being unreachable used to discard the answer the other had
    // already produced and fail the whole meeting. The surviving statement is
    // the user's, and throwing it away helps nobody.
    expect(result.replies.map((reply) => reply.employeeId)).toEqual([lead.id])
    const [session] = store.listSessions(company.id)
    const [turn] = store.listSessionTurns(session!.id)
    expect(turn).toMatchObject({ status: 'completed' })
    expect(store.listTurnAgentRuns(turn!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ employeeId: lead.id, status: 'completed' }),
      expect.objectContaining({ employeeId: engineer.id, status: 'failed' }),
    ]))
    // Completed-with-a-casualty is not the same as clean, and the difference
    // has to survive into the record.
    const finished = store.listWorldDomainEvents(company.id).find((event) => event.type === 'meeting.finished')
    expect(finished?.payload).toMatchObject({
      status: 'completed',
      failedSpeakers: [expect.objectContaining({ employeeId: engineer.id })],
    })
  })

  it('fails the meeting only when no character managed to speak', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('lead-down', '老王', '技术经理'))
    store.saveBlueprint(blueprint('engineer-down', '小刘', '软件工程师'))
    const lead = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'lead-down', blueprintVersion: 1 })
    const engineer = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'engineer-down', blueprintVersion: 1 })
    const runtime: AgentRuntimePort = {
      async runTurn() { throw new Error('runtime unavailable') },
      async close() {},
    }
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await expect(orchestrator.group({
      workspaceId: workspace.id, worldId: company.id, employeeIds: [lead.id, engineer.id], prompt: '执行两步检查',
    })).rejects.toThrow('Agent model turn failed')
    const [session] = store.listSessions(company.id)
    const [turn] = store.listSessionTurns(session!.id)
    expect(turn).toMatchObject({ status: 'failed' })
  })

  it('interrupts one live AgentRun as interrupted and publishes a durable stop notice', async () => {
    const { directory, store, workspace, company } = await setup()
    store.saveBlueprint(blueprint('interruptible', '小刘', '软件工程师'))
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'interruptible', blueprintVersion: 1 })
    const runtime = new AbortableRuntime()
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const running = orchestrator.direct({ workspaceId: workspace.id, worldId: company.id, employeeId: employee.id, prompt: '长任务' })
    await runtime.waitUntilStarted()
    const control = await orchestrator.interruptWorkTurn(runtime.workTurnId!)
    await expect(running).rejects.toThrow('interrupted')

    expect(control).toMatchObject({ workTurnId: runtime.workTurnId, status: 'interrupted', content: '已停止' })
    expect(runtime.abortedRunIds).toEqual([runtime.agentRunId])
    expect(store.getWorkTurn(runtime.workTurnId!)?.status).toBe('interrupted')
    expect(store.listTurnAgentRuns(runtime.workTurnId!)[0]).toMatchObject({ status: 'interrupted', errorCode: 'interrupted' })
    expect(store.listMessages(store.getWorkTurn(runtime.workTurnId!)!.sessionId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'system', content: '已停止' })]),
    )
  })

  it('rejects cross-world role mixing before a runtime starts', async () => {
    const { directory, store, workspace, company, tavern } = await setup()
    store.saveBlueprint(blueprint('engineer', '小刘', '软件工程师'))
    store.saveBlueprint(blueprint('bard', '弦月', '吟游诗人', 'tavern'))
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const bard = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: tavern.id,
      blueprintId: 'bard',
      blueprintVersion: 1,
    })
    const runtime = new FakeRuntime({})
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await expect(
      orchestrator.group({
        workspaceId: workspace.id,
        worldId: company.id,
        employeeIds: [engineer.id, bard.id],
        prompt: '混合两个世界',
      }),
    ).rejects.toThrow('does not belong to this world')
    expect(runtime.calls).toHaveLength(0)
  })
})
