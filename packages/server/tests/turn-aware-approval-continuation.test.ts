import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint } from '@dsh-cyber/contracts'
import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CharacterSkillRuntime } from '../src/services/character-skill-runtime.js'
import { TurnAwareApprovalContinuationService } from '../src/services/turn-aware-approval-continuation-service.js'
import { WorldPackageInstanceService } from '../src/services/world-package-instance-service.js'
import { WorldRootService } from '../src/services/world-root-service.js'
import { WorldRuntimeContextComposer } from '../src/services/world-runtime-context-composer.js'
import { SqliteSkillActionRepository } from '../src/skills/sqlite-skill-action-repository.js'
import { CharacterSkillAdapterRegistry, type CharacterSkillAdapter, type CharacterSkillMatchContext } from '../src/skills/skill-adapter.js'

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('turn-aware approval continuation', () => {
  it('keeps waiting-approval authoritative across a real SQLite reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-turn-wait-restart-')); roots.push(root)
    const databasePath = join(root, 'data', 'dsh-cyber.sqlite')
    const first = await SqliteStore.open(databasePath)
    const workspace = first.createWorkspace({ name: '重启工作区' })
    const world = first.createWorld({ workspaceId: workspace.id, name: '重启世界', templateId: 'personal-world' })
    const session = first.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '重启会话' })
    const turn = first.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
    first.startWorkTurn(turn.id)
    first.waitWorkTurnForApproval(turn.id)
    first.close()

    const reopened = await SqliteStore.open(databasePath); stores.push(reopened)
    reopened.recoverConversationRuntimeAfterRestart()

    const recovered = reopened.getWorkTurn(turn.id)!
    expect(recovered.status).toBe('waiting-approval')
    expect(recovered.errorCode).not.toBe('service-restarted')
  })

  it('waits without a Worker, then approves once and completes the same WorkTurn with one AgentRun', async () => {
    const fixture = await setup()
    const pending = await fixture.continuations.direct(request(fixture, '请执行 external'))

    expect(pending.waitingForApproval).toBe(true)
    expect(fixture.agent.calls).toHaveLength(0)
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('waiting-approval')
    const [action] = fixture.store.listWorldSkillActions(fixture.worldId)
    const [approval] = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')
    expect(action).toMatchObject({ workTurnId: pending.workTurnId, status: 'waiting-for-approval' })
    expect(approval).toMatchObject({ sessionId: pending.session.id, workTurnId: pending.workTurnId })
    expect(approval?.agentRunId).toBeUndefined()

    const decided = await fixture.continuations.decideApproval(approval!.id, 'approved', 'once', 'owner')
    expect(decided.continuation?.workTurnId).toBe(pending.workTurnId)
    expect(fixture.adapter.executed).toBe(1)
    expect(fixture.agent.calls).toHaveLength(1)
    expect(fixture.agent.calls[0]?.prompt).toContain('外部测试动作已执行')
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
    expect(fixture.store.listTurnAgentRuns(pending.workTurnId)).toEqual([
      expect.objectContaining({ turnId: pending.workTurnId, ordinal: 1, status: 'completed' }),
    ])
    await expect(fixture.continuations.decideApproval(approval!.id, 'approved', 'once', 'owner'))
      .rejects.toMatchObject({ code: 'approval_already_decided' })
    expect(fixture.adapter.executed).toBe(1)
  })

  it.each([
    ['rejected' as const, 'rejected' as const, '审批被拒绝'],
    ['expired' as const, 'approved' as const, '审批已过期'],
  ])('%s never executes the Adapter and still finishes with a factual answer', async (kind, decision, fact) => {
    const fixture = await setup()
    const pending = await fixture.continuations.direct(request(fixture, '请执行 external'))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!
    const now = kind === 'expired' ? new Date(Date.now() + 11 * 60_000) : new Date()

    await fixture.continuations.decideApproval(approval.id, decision, 'once', 'owner', now)

    expect(fixture.adapter.executed).toBe(0)
    expect(fixture.agent.calls).toHaveLength(1)
    expect(fixture.agent.calls[0]?.prompt).toContain(fact)
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
  })

  it('recovers an approved request that crashed before the execution claim', async () => {
    const fixture = await setup()
    const pending = await fixture.continuations.direct(request(fixture, '请执行 external'))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!

    // Persist the decision only, exactly matching the process-death window.
    fixture.store.decideApprovalRequest(approval.id, 'approved', 'once', 'owner')
    await fixture.continuations.recover()

    expect(fixture.adapter.executed).toBe(1)
    expect(fixture.agent.calls).toHaveLength(1)
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
    expect(fixture.store.getSkillAction(approval.subjectId)).toMatchObject({ executionState: 'settled', status: 'executed' })
  })

  it('turns an in-flight external boundary into outcome-unknown and never retries it', async () => {
    const fixture = await setup()
    const pending = await fixture.continuations.direct(request(fixture, '请执行 external'))
    const approval = fixture.store.listWorldApprovalRequests(fixture.worldId, 'pending')[0]!
    fixture.store.decideApprovalRequest(approval.id, 'approved', 'once', 'owner')
    fixture.store.reconcileApprovedSkillActions()
    fixture.store.claimSkillActionExecution(approval.subjectId, 'crashed-attempt')

    fixture.store.recoverSkillActionsAfterRestart()
    await fixture.continuations.recover()

    expect(fixture.adapter.executed).toBe(0)
    expect(fixture.store.getSkillAction(approval.subjectId)).toMatchObject({ status: 'outcome-unknown', executionState: 'settled' })
    expect(fixture.store.getWorkTurn(pending.workTurnId)?.status).toBe('completed')
    expect(fixture.agent.calls[0]?.prompt).toContain('结果未知')
  })
})

class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '已根据真实执行结果回复。', eventCount: 0 }
  }
  async close() {}
}

class ApprovalAdapter implements CharacterSkillAdapter {
  readonly id = 'test.approval-adapter'
  readonly descriptors: readonly CharacterSkillDescriptor[] = [{
    id: 'test.approval', displayName: '审批测试', summary: '验证持久生命周期', adapterId: this.id,
    risks: ['external-side-effect'], supportsScheduling: false, persistentApproval: 'exact-target',
  }]
  executed = 0
  propose(context: CharacterSkillMatchContext) {
    return context.prompt.includes('external') ? [{
      skillId: 'test.approval', adapterId: this.id, action: 'external.run', target: 'exact:test',
      label: '执行外部测试动作', risk: 'external-side-effect' as const,
      authorization: 'explicit-user-request' as const, parameters: {},
    }] : []
  }
  async execute(_action: CharacterSkillAction) {
    this.executed += 1
    return { status: 'executed' as const, detail: '外部测试动作已执行' }
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-turn-approval-')); roots.push(root)
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite')); stores.push(store)
  const workspace = store.createWorkspace({ name: '审批测试工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '审批测试世界', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: 'approval-worker', version: 1, worldTemplateId: 'personal-world',
    displayName: '审批员', role: '审批测试', summary: '测试', persona: '只根据真实结果回复',
    requestedSkills: ['test.approval'], requestedCapabilities: [], createdAt: '2026-08-25T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({
    workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id,
    blueprintVersion: 1, skillGrants: ['test.approval'],
  })
  const adapter = new ApprovalAdapter()
  const registry = new CharacterSkillAdapterRegistry(); registry.register(adapter)
  const skills = new CharacterSkillRuntime(store, { registry, actions: new SqliteSkillActionRepository(store) })
  const agent = new RecordingRuntime()
  const orchestrator = new ConversationOrchestrator({ store, runtime: agent, workspacePath: root })
  const worldRoots = new WorldRootService(root)
  const continuations = new TurnAwareApprovalContinuationService({
    store, orchestrator, skills, settings: new WorldRuntimeContextComposer(),
    worldPackages: new WorldPackageInstanceService(store, worldRoots),
  })
  return { store, workspaceId: workspace.id, worldId: world.id, employeeId: employee.id, adapter, agent, continuations }
}

function request(fixture: Awaited<ReturnType<typeof setup>>, prompt: string) {
  return {
    workspaceId: fixture.workspaceId, worldId: fixture.worldId, employeeId: fixture.employeeId,
    prompt, skillPrompt: prompt, transformedPrompt: prompt,
  }
}
