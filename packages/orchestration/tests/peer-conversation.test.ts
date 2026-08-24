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

class PeerRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  readonly counters = new Map<string, number>()

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    const next = (this.counters.get(request.agent.id) ?? 0) + 1
    this.counters.set(request.agent.id, next)
    const content = `${request.agent.displayName}第${next}次发言：${request.agent.role}已核对事实。`
    const sessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    for (const event of events(sessionId, content)) request.onEvent?.(event)
    return { agentSessionId: sessionId, finalResponse: content, eventCount: 3 }
  }

  async close(): Promise<void> {}
}

function events(sessionId: string, content: string): AgentRuntimeEvent[] {
  return [
    { kind: 'turn.started', source: 'peer-test', sourceSessionId: sessionId, metadata: {} },
    { kind: 'assistant.message', source: 'peer-test', sourceSessionId: sessionId, content, metadata: {} },
    { kind: 'turn.completed', source: 'peer-test', sourceSessionId: sessionId, metadata: {} },
  ]
}

function blueprint(id: string, displayName: string, role: string, worldTemplateId = 'cyber-company'): EmployeeBlueprint {
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
    createdAt: '2026-08-22T00:00:00.000Z',
  }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-peer-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地实例' })
  const company = store.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
  const tavern = store.createWorld({ workspaceId: workspace.id, name: '酒馆', templateId: 'tavern' })
  store.saveBlueprint(blueprint('secretary', '林秘书', '行政秘书'))
  store.saveBlueprint(blueprint('engineer', '小刘', '开发工程师'))
  store.saveBlueprint(blueprint('researcher', '阿研', '研究员'))
  store.saveBlueprint(blueprint('bard', '弦月', '吟游诗人', 'tavern'))
  const secretary = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'secretary', blueprintVersion: 1 })
  const engineer = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'engineer', blueprintVersion: 1 })
  const researcher = store.recruitEmployee({ workspaceId: workspace.id, worldId: company.id, blueprintId: 'researcher', blueprintVersion: 1 })
  const bard = store.recruitEmployee({ workspaceId: workspace.id, worldId: tavern.id, blueprintId: 'bard', blueprintVersion: 1 })
  const runtime = new PeerRuntime()
  const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
  orchestrators.push(orchestrator)
  return { store, workspace, company, secretary, engineer, researcher, bard, runtime, orchestrator }
}

describe('peer conversations', () => {
  it('runs an ownerless bounded meeting with targets first and the initiator summarizing last', async () => {
    const { store, workspace, company, secretary, engineer, runtime, orchestrator } = await setup()
    const result = await orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: secretary.id,
      participantIds: [engineer.id],
      purpose: '确认项目当前进度，并形成可向用户汇报的下一步。',
      maxRounds: 2,
    })

    expect(result.session.kind).toBe('meeting')
    expect(result.participantIds).toEqual([secretary.id, engineer.id])
    expect(result.rounds).toBe(2)
    expect(runtime.calls.map((call) => call.agent.id)).toEqual([
      engineer.id,
      secretary.id,
      engineer.id,
      secretary.id,
    ])
    expect(runtime.calls[1]?.prompt).toContain('小刘第1次发言')
    expect(runtime.calls[3]?.prompt).toContain('林秘书第1次发言')
    expect(runtime.calls.every((call) => call.workspacePath.length > 0)).toBe(true)

    const participants = store.listParticipants(result.session.id)
    expect(participants).toHaveLength(2)
    expect(participants.every((participant) => participant.kind === 'employee')).toBe(true)
    expect(participants.some((participant) => participant.participantId === 'owner')).toBe(false)
    expect(store.listMessages(result.session.id).filter((message) => message.kind === 'assistant')).toHaveLength(4)
    const [turn] = store.listSessionTurns(result.session.id)
    expect(turn).toMatchObject({ interactionKind: 'peer', status: 'completed' })
    expect(store.listTurnAgentRuns(turn!.id).map((run) => run.ordinal)).toEqual([1, 2, 3, 4])

    const events = store.listWorldDomainEvents(company.id).filter((event) => event.sessionId === result.session.id)
    expect(events.find((event) => event.type === 'meeting.started')?.payload).toMatchObject({
      peerConversation: true,
      initiatorId: secretary.id,
      maxRounds: 2,
    })
    expect(events.find((event) => event.type === 'meeting.finished')?.payload).toMatchObject({
      peerConversation: true,
      status: 'completed',
      replyCount: 4,
    })
  })

  it('uses each role own runtime session and never merges their identities', async () => {
    const { workspace, company, secretary, engineer, researcher, runtime, orchestrator } = await setup()
    await orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: secretary.id,
      participantIds: [engineer.id, researcher.id],
      purpose: '核对技术进度与研究结论。',
    })

    expect(runtime.calls.map((call) => call.agent.id)).toEqual([engineer.id, researcher.id, secretary.id])
    expect(new Set(runtime.calls.map((call) => call.agent.agentSessionId ?? call.agent.id)).size).toBe(3)
    expect(runtime.calls[0]?.prompt).toContain('你是被 林秘书 邀请参与协作的角色')
    expect(runtime.calls.at(-1)?.prompt).toContain('你是本次协作的发起者')
  })

  it('keeps a later user-defined persona authoritative over the original template role during collaboration', async () => {
    const { store, workspace, company, secretary, engineer, runtime, orchestrator } = await setup()
    const persona = '你是一只名叫团子的陪伴小猫，傲娇、敏感，以伙伴身份和用户相处。'
    store.reviseEmployee({
      employeeId: secretary.id,
      persona,
      reason: 'user-redefined-identity',
    })

    await orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: secretary.id,
      participantIds: [engineer.id],
      purpose: '讨论今天要做的事情。',
    })

    const secretaryCall = runtime.calls.find((call) => call.agent.id === secretary.id)
    expect(secretaryCall?.revision.persona).toBe(persona)
    expect(runtime.calls.every((call) => !call.prompt.includes('行政秘书'))).toBe(true)
    expect(runtime.calls[0]?.prompt).toContain('参与角色：林秘书、小刘')
    expect(runtime.calls[0]?.prompt).toContain('当前 Persona')
  })

  it('rejects unbounded, undersized and cross-world collaboration before model calls', async () => {
    const { workspace, company, secretary, engineer, researcher, bard, runtime, orchestrator } = await setup()
    await expect(orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: secretary.id,
      participantIds: [],
      purpose: '只有一个角色',
    })).rejects.toThrow('2 to 4')
    await expect(orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: secretary.id,
      participantIds: [engineer.id],
      purpose: '轮次过多',
      maxRounds: 4,
    })).rejects.toThrow('between 1 and 3')
    await expect(orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: secretary.id,
      participantIds: [engineer.id, researcher.id, bard.id],
      purpose: '跨世界角色',
    })).rejects.toThrow('does not belong to this world')
    expect(runtime.calls).toHaveLength(0)
  })
})
