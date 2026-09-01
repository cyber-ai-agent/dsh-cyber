import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import { SqliteStore, WorldArtifactRepository } from '@dsh-cyber/persistence'

import { WorldTraceService } from '../src/services/world-trace-service.js'
import type { CharacterSkillActionRepository } from '../src/skills/skill-action-repository.js'

/**
 * Phase F — what a run actually produced, and what it honestly did not.
 *
 * The trace has to answer 产出了什么结果 from the durable Artifact registry, and
 * it has to answer 判断依据 with silence when the runtime published no public
 * reasoning summary. Both are facts about the run, never about the model.
 */

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

class MemoryActions implements CharacterSkillActionRepository {
  async reserve(action: CharacterSkillAction) { return { action, created: true } }
  async save(): Promise<void> {}
  async listByWorld(): Promise<CharacterSkillAction[]> { return [] }
  async listDue(): Promise<CharacterSkillAction[]> { return [] }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-trace-outcome-'))
  const store = await SqliteStore.open(join(root, 'trace.sqlite'))
  stores.push(store)
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
  const workspace = store.createWorkspace({ name: '轨迹产出测试' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '测试世界', templateId: 'personal-world' })
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'core.butler',
    blueprintVersion: 1,
    displayName: '测试角色',
  })
  const session = store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: '测试会话',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  const artifacts = new WorldArtifactRepository(store.database)
  return { store, workspace, world, session, employee, artifacts }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function runWithTools(context: Fixture, options: { reasoning?: string } = {}) {
  const { store, workspace, world, session, employee } = context
  const turn = store.createWorkTurn({
    workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat',
  })
  store.startWorkTurn(turn.id)
  const run = store.createAgentRun({
    workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
    turnId: turn.id, employeeId: employee.id, ordinal: 1,
  })
  store.startAgentRun(run.id)
  if (options.reasoning !== undefined) {
    store.appendMessage({
      sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'reasoning',
      content: options.reasoning, metadata: { agentRunId: run.id, traceTurnId: run.id },
    })
  }
  store.appendMessage({
    sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'tool-call',
    content: 'write_file', metadata: { agentRunId: run.id, traceTurnId: run.id, callId: `call-${run.id}`, toolName: 'write_file' },
  })
  store.appendMessage({
    sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'tool-result',
    content: '已完成', metadata: { agentRunId: run.id, traceTurnId: run.id, callId: `call-${run.id}`, failed: false },
  })
  store.completeAgentRun(run.id, `runtime-${run.id}`)
  store.completeWorkTurn(turn.id)
  return { run, turn }
}

function twoRunsOneTurn(context: Fixture) {
  const { store, workspace, world, session, employee } = context
  const turn = store.createWorkTurn({
    workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'task',
  })
  store.startWorkTurn(turn.id)
  const runs = [1, 2].map((ordinal) => {
    const run = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, sessionId: session.id,
      turnId: turn.id, employeeId: employee.id, ordinal,
    })
    store.startAgentRun(run.id)
    store.completeAgentRun(run.id, `runtime-${run.id}`)
    return run
  })
  store.completeWorkTurn(turn.id)
  return { runs, turn }
}

function publishReport(context: Fixture, options: {
  title: string
  path: string
  sha256: string
  agentRunId?: string
  workTurnId?: string
}) {
  const publishInput = {
    workspaceId: context.workspace.id,
    worldId: context.world.id,
    title: options.title,
    kind: 'markdown' as const,
    relativePath: options.path,
    byteLength: 128,
    sha256: options.sha256,
    createdByKind: 'employee' as const,
    createdById: context.employee.id,
    employeeId: context.employee.id,
    sessionId: context.session.id,
    ...(options.workTurnId === undefined ? {} : { workTurnId: options.workTurnId }),
    ...(options.agentRunId === undefined ? {} : { agentRunId: options.agentRunId }),
  }
  return context.artifacts.publish(publishInput)
}

describe('World Trace run outcome', () => {
  it('names the artifact a run published and attaches it to that run only', async () => {
    const context = await fixture()
    const producing = runWithTools(context)
    const quiet = runWithTools(context)
    const published = publishReport(context, {
      title: '周度分析报告',
      path: 'reports/weekly.md',
      sha256: 'a'.repeat(64),
      agentRunId: producing.run.id,
      workTurnId: producing.turn.id,
    })

    const service = new WorldTraceService({ store: context.store, actions: new MemoryActions(), artifacts: context.artifacts })
    const page = await service.list(context.world.id, { limit: 200 })
    const runs = page.items.filter((item) => item.sourceKind === 'agent-run')
    expect(runs).toHaveLength(2)

    const producingEntry = runs.find((item) => item.runId === producing.run.id)
    expect(producingEntry?.artifacts).toEqual([{
      artifactId: published.artifact.id,
      title: '周度分析报告',
      kind: 'markdown',
      version: 1,
      createdAt: published.version.createdAt,
    }])

    // A run that published nothing says nothing. The registry is the only
    // authority here; the trace never attributes a neighbour's output.
    const quietEntry = runs.find((item) => item.runId === quiet.run.id)
    expect(quietEntry).toBeDefined()
    expect(quietEntry).not.toHaveProperty('artifacts')
  })

  it('does not guess a run for an artifact recorded only against a multi-run work turn', async () => {
    const context = await fixture()
    const { runs, turn } = twoRunsOneTurn(context)
    publishReport(context, {
      title: '仅按回合登记的产物',
      path: 'reports/turn-only.md',
      sha256: 'b'.repeat(64),
      workTurnId: turn.id,
    })

    const service = new WorldTraceService({ store: context.store, actions: new MemoryActions(), artifacts: context.artifacts })
    const page = await service.list(context.world.id, { limit: 200 })
    const entries = page.items.filter((item) => runs.some((run) => run.id === item.runId))
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.artifacts === undefined)).toBe(true)
  })

  it('finds a run by the title of what it produced', async () => {
    const context = await fixture()
    const { run, turn } = runWithTools(context)
    publishReport(context, {
      title: '季度成本核对表',
      path: 'reports/cost.md',
      sha256: 'c'.repeat(64),
      agentRunId: run.id,
      workTurnId: turn.id,
    })

    const service = new WorldTraceService({ store: context.store, actions: new MemoryActions(), artifacts: context.artifacts })
    const found = await service.list(context.world.id, { search: '季度成本核对表', limit: 200 })
    expect(found.items.map((item) => item.runId)).toContain(run.id)
  })

  it('leaves the reasoning summary absent when the runtime published none', async () => {
    const context = await fixture()
    const silent = runWithTools(context)
    const speaking = runWithTools(context, { reasoning: '先核对事实，再写入文件。' })

    const service = new WorldTraceService({ store: context.store, actions: new MemoryActions(), artifacts: context.artifacts })
    const page = await service.list(context.world.id, { limit: 200 })
    const silentEntry = page.items.find((item) => item.runId === silent.run.id)
    const speakingEntry = page.items.find((item) => item.runId === speaking.run.id)

    // Absent, not empty and not filled in. Nothing may stand in for a summary
    // the runtime never produced — least of all a narrative of hidden thought.
    expect(silentEntry).toBeDefined()
    expect(silentEntry).not.toHaveProperty('reasoningSummary')
    expect(silentEntry?.tools).toHaveLength(1)
    expect(speakingEntry?.reasoningSummary).toBe('先核对事实，再写入文件。')
  })

  it('publishes the durable run id so a card can be joined back to its AgentRun', async () => {
    const context = await fixture()
    const { run } = runWithTools(context)
    const service = new WorldTraceService({ store: context.store, actions: new MemoryActions(), artifacts: context.artifacts })
    const page = await service.list(context.world.id, { limit: 200 })
    expect(page.items.find((item) => item.sourceKind === 'agent-run')?.runId).toBe(run.id)
  })
})
