import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint } from '@dsh-cyber/contracts'
import { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'

import { PeerCollaborationService } from '../src/services/peer-collaboration-service.js'

const stores: SqliteStore[] = []
const orchestrators: ConversationOrchestrator[] = []

afterEach(async () => {
  for (const orchestrator of orchestrators.splice(0)) await orchestrator.close()
  for (const store of stores.splice(0)) store.close()
})

class ServiceRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    const content = request.agent.role.includes('工程')
      ? '开发已完成接口层，剩余端到端验证。'
      : '我会整理为：接口层完成，下一步补端到端验证。'
    const sourceSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    request.onEvent?.({ kind: 'turn.started', source: 'service-test', sourceSessionId, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'service-test', sourceSessionId, content, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'service-test', sourceSessionId, metadata: {} })
    return { agentSessionId: sourceSessionId, finalResponse: content, eventCount: 3 }
  }

  async close(): Promise<void> {}
}

function blueprint(id: string, displayName: string, role: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role,
    summary: `${role}角色`,
    persona: `你是${displayName}。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-22T00:00:00.000Z',
  }
}

describe('PeerCollaborationService', () => {
  it('records a grounded shared episode and symmetric relationship evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-peer-service-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
    store.saveBlueprint(blueprint('secretary', '林秘书', '行政秘书'))
    store.saveBlueprint(blueprint('engineer', '小刘', '开发工程师'))
    const secretary = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'secretary', blueprintVersion: 1 })
    const engineer = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'engineer', blueprintVersion: 1 })
    const orchestrator = new ConversationOrchestrator({ store, runtime: new ServiceRuntime(), workspacePath: directory })
    orchestrators.push(orchestrator)
    const simulationStore = new WorldSimulationStore(store)
    const service = new PeerCollaborationService({
      store,
      simulationStore,
      orchestrator,
      clock: () => '2026-08-22T08:00:00.000Z',
    })

    const result = await service.run({
      workspaceId: workspace.id,
      worldId: world.id,
      initiatorId: secretary.id,
      participantIds: [engineer.id],
      purpose: '请向开发工程师确认当前进度，并整理成汇报。',
      maxRounds: 1,
    })

    expect(result.episode.participantIds).toEqual([secretary.id, engineer.id])
    expect(result.episode.summary).toContain('小刘：开发已完成接口层')
    expect(result.episode.summary).toContain('林秘书：我会整理为')
    expect(result.episode.sourceMessageIds.length).toBeGreaterThanOrEqual(3)
    expect(simulationStore.listSharedEpisodes(world.id)).toEqual([result.episode])

    expect(store.listEmployeeRelationships(secretary.id)).toEqual([
      expect.objectContaining({ colleagueId: engineer.id, collaborationCount: 1 }),
    ])
    expect(store.listEmployeeRelationships(engineer.id)).toEqual([
      expect.objectContaining({ colleagueId: secretary.id, collaborationCount: 1 }),
    ])
    expect(result.relationships).toHaveLength(2)
  })
})
