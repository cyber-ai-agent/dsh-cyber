import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
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

/** Records what each turn was actually asked to remember. */
class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  readonly responses: Record<string, string>

  constructor(responses: Record<string, string> = {}) {
    this.responses = responses
  }

  async runTurn(request: AgentTurnRequest) {
    this.calls.push({ ...request, history: request.history.map((entry) => ({ ...entry })) })
    const content = this.responses[`${request.conversationId}:${request.agent.id}`]
      ?? this.responses[request.agent.id]
      ?? `reply:${request.agent.displayName}`
    request.onEvent?.({
      kind: 'assistant.message',
      source: 'test-runtime',
      sourceSessionId: `session-${this.calls.length}`,
      content,
      metadata: {},
    })
    return { agentSessionId: `session-${this.calls.length}`, finalResponse: content, eventCount: 1 }
  }

  async close(): Promise<void> {}

  transcriptOf(index: number): string[] {
    return (this.calls[index]?.history ?? []).map((entry) => `${entry.speakerName}：${entry.content}`)
  }
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

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-memory-'))
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
  store.saveBlueprint(blueprint('engineer', '小刘', '软件工程师'))
  store.saveBlueprint(blueprint('architect', '老王', '架构师'))
  store.saveBlueprint(blueprint('bartender', '阿岚', '调酒师', 'tavern'))
  return { directory, store, workspace, company, tavern }
}

describe('conversation memory authority', () => {
  it('starts a brand-new direct session with no recovered history', async () => {
    const { directory, store, workspace, company } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime()
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const result = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: '第一次见面。',
    })

    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]!.history).toEqual([])
    expect(runtime.calls[0]!.conversationId).toBe(result.session.id)
  })

  it('recovers the previous exchange on the next turn without repeating the live prompt', async () => {
    const { directory, store, workspace, company } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime({ [engineer.id]: '我先建立性能基线。' })
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const first = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: '登录接口最近变慢了。',
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      sessionId: first.session.id,
      prompt: '基线跑出来了吗？',
    })

    expect(runtime.transcriptOf(1)).toEqual([
      '用户：登录接口最近变慢了。',
      '小刘：我先建立性能基线。',
    ])
    // The live prompt reaches the model as the request, never also as history.
    expect(runtime.transcriptOf(1)).not.toContain('用户：基线跑出来了吗？')
    expect(runtime.calls[1]!.conversationId).toBe(first.session.id)
  })

  it('never lets one direct session read another', async () => {
    const { directory, store, workspace, company } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime({ [engineer.id]: '收到。' })
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const alpha = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: 'ALPHA 会话的秘密。',
    })
    const beta = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: 'BETA 会话的秘密。',
    })
    expect(beta.session.id).not.toBe(alpha.session.id)

    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      sessionId: beta.session.id,
      prompt: '继续 BETA。',
    })

    const betaHistory = JSON.stringify(runtime.calls[2]!.history)
    expect(betaHistory).toContain('BETA 会话的秘密。')
    expect(betaHistory).not.toContain('ALPHA 会话的秘密。')
  })

  it('never lets one world read another', async () => {
    const { directory, store, workspace, company, tavern } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const bartender = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: tavern.id,
      blueprintId: 'bartender',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime()
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: '公司世界的机密路线图。',
    })
    const tavernSession = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: tavern.id,
      employeeId: bartender.id,
      prompt: '来一杯月影特调。',
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: tavern.id,
      employeeId: bartender.id,
      sessionId: tavernSession.session.id,
      prompt: '再来一杯。',
    })

    const tavernHistory = JSON.stringify(runtime.calls[2]!.history)
    expect(tavernHistory).toContain('来一杯月影特调。')
    expect(tavernHistory).not.toContain('公司世界的机密路线图。')
  })

  it('gives a group only its own prior turns and keeps every speaker identifiable', async () => {
    const { directory, store, workspace, company } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const architect = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'architect',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime({
      [engineer.id]: '回归测试还没跑完。',
      [architect.id]: '我同意延后一天。',
    })
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const first = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [engineer.id, architect.id],
      prompt: '这次发布要不要延后？',
    })
    // Both characters of the first round start from an empty transcript.
    expect(runtime.calls[0]!.history).toEqual([])
    expect(runtime.calls[1]!.history).toEqual([])

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [engineer.id, architect.id],
      sessionId: first.session.id,
      prompt: '那就延后，谁来通知？',
    })

    expect(runtime.transcriptOf(2)).toEqual([
      '用户：这次发布要不要延后？',
      '小刘：回归测试还没跑完。',
      '老王：我同意延后一天。',
    ])
    // The second speaker of the new round sees the same prior history; the
    // statements of the round in progress arrive through the group prompt.
    expect(runtime.transcriptOf(3)).toEqual(runtime.transcriptOf(2))
    expect(runtime.calls[3]!.prompt).toContain('回归测试还没跑完。')
  })

  it('keeps a direct chat and a group meeting of the same character separate', async () => {
    const { directory, store, workspace, company } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const architect = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'architect',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime()
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    const direct = await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: '私聊里的绩效谈话。',
    })
    const meeting = await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [engineer.id, architect.id],
      prompt: '群聊里的排期讨论。',
    })

    await orchestrator.group({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeIds: [engineer.id, architect.id],
      sessionId: meeting.session.id,
      prompt: '继续排期。',
    })
    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      sessionId: direct.session.id,
      prompt: '继续绩效。',
    })

    const groupHistory = JSON.stringify(runtime.calls[3]!.history)
    const directHistory = JSON.stringify(runtime.calls.at(-1)!.history)
    expect(groupHistory).toContain('群聊里的排期讨论。')
    expect(groupHistory).not.toContain('私聊里的绩效谈话。')
    expect(directHistory).toContain('私聊里的绩效谈话。')
    expect(directHistory).not.toContain('群聊里的排期讨论。')
  })

  it('starts a peer collaboration with no recovered history', async () => {
    const { directory, store, workspace, company } = await setup()
    const engineer = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'engineer',
      blueprintVersion: 1,
    })
    const architect = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: company.id,
      blueprintId: 'architect',
      blueprintVersion: 1,
    })
    const runtime = new RecordingRuntime()
    const orchestrator = new ConversationOrchestrator({ store, runtime, workspacePath: directory })
    orchestrators.push(orchestrator)

    await orchestrator.direct({
      workspaceId: workspace.id,
      worldId: company.id,
      employeeId: engineer.id,
      prompt: '私聊里的敏感信息。',
    })
    await orchestrator.peer({
      workspaceId: workspace.id,
      worldId: company.id,
      initiatorId: engineer.id,
      participantIds: [architect.id],
      purpose: '核对发布风险',
    })

    for (const call of runtime.calls.slice(1)) {
      expect(call.history).toEqual([])
      expect(JSON.stringify(call.history)).not.toContain('私聊里的敏感信息。')
    }
  })
})
