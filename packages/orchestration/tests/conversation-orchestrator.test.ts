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
    const durableAtEmit: Array<{ kind: AgentRuntimeEvent['kind']; persisted: boolean }> = []
    orchestrator.subscribe((event) => {
      realtime.push(event.event)
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
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: employee.id,
      sessionId: first.session.id,
      prompt: '继续给出验收标准',
    })

    expect(runtime.calls).toHaveLength(2)
    expect(store.getEmployee(employee.id)?.agentSessionId).toBe(`agent-${employee.id}`)
    expect(realtime.some((event) => event.kind === 'reasoning.delta')).toBe(true)
    expect(durableAtEmit
      .filter((item) => ['turn.started', 'tool.started', 'assistant.message', 'turn.completed'].includes(item.kind))
      .every((item) => item.persisted)).toBe(true)
    expect(store.listMessages(first.session.id).some((message) => message.content === 'stream-only')).toBe(
      false,
    )
    expect(
      store.listMessages(first.session.id).filter((message) => message.kind === 'assistant'),
    ).toHaveLength(2)
    expect(store.listWorldDomainEvents(company.id).at(-1)?.type).toBe('task.completed')
    expect(store.getEmployee(employee.id)?.status).toBe('available')
  })

  it('runs two independent agents in sequence and gives the second the first real statement', async () => {
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

    expect(result.replies.map((reply) => reply.employeeId)).toEqual([lead.id, engineer.id])
    expect(runtime.calls[0]?.agent.id).toBe(lead.id)
    expect(runtime.calls[1]?.agent.id).toBe(engineer.id)
    expect(runtime.calls[1]?.prompt).toContain('老王：先建立监控基线，再决定改动范围。')
    expect(store.listMessages(result.session.id).filter((message) => message.kind === 'assistant')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ senderId: lead.id }),
        expect.objectContaining({ senderId: engineer.id }),
      ]),
    )
    const eventTypes = store.listWorldDomainEvents(company.id).map((event) => event.type)
    expect(eventTypes).toContain('meeting.started')
    expect(eventTypes).toContain('meeting.finished')
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
