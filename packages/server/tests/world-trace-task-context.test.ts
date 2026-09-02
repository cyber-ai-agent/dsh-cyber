import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRun, ContextSnapshot, WorkSession } from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import { SqliteStore, WorkSystemRepository } from '@dsh-cyber/persistence'

import { ContextSnapshotService } from '../src/services/context-snapshot-service.js'
import { WorldTraceService, groupTasksByRun } from '../src/services/world-trace-service.js'
import type { CharacterSkillActionRepository } from '../src/skills/skill-action-repository.js'

/**
 * Two things a trace card must be honest about, per Phase F's follow-ups:
 *
 * - 任务目标: `taskId` is a real `work_tasks` row when `task_runs` says the run
 *   belonged to it, and absent otherwise. Never a turn id dressed as a task.
 * - 用了什么上下文: the durable D4 snapshot's numbers ride on the card; a run
 *   without a snapshot carries no context field at all, so a renderer cannot
 *   mistake "unknown" for "zero".
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
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-trace-task-'))
  const store = await SqliteStore.open(join(root, 'trace.sqlite'))
  stores.push(store)
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
  const workspace = store.createWorkspace({ name: '任务轨迹' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '任务世界', templateId: 'personal-world' })
  const recruit = (displayName: string) => store.recruitEmployee({
    workspaceId: workspace.id, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName,
  })
  const alice = recruit('小林')
  const bob = recruit('小周')
  return { store, workspace, world, alice, bob }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function session(context: Fixture, kind: 'direct' | 'group', employeeIds: string[]): WorkSession {
  return context.store.createSession({
    workspaceId: context.workspace.id,
    worldId: context.world.id,
    kind,
    ...(kind === 'group' ? { collaborationMode: 'task' as const } : {}),
    title: kind === 'group' ? '任务协作' : '私聊',
    participants: [{ participantId: 'owner', kind: 'owner' }, ...employeeIds.map((id) => ({ participantId: id, kind: 'employee' as const }))],
  })
}

/** A completed turn with one completed run per employee. */
function completedTurn(context: Fixture, target: WorkSession, employeeIds: string[]) {
  const { store } = context
  const turn = store.createWorkTurn({
    workspaceId: context.workspace.id, worldId: context.world.id, sessionId: target.id,
    interactionKind: target.kind === 'group' ? 'task' : 'chat',
  })
  store.startWorkTurn(turn.id)
  const runs: AgentRun[] = employeeIds.map((employeeId, index) => {
    const run = store.createAgentRun({
      workspaceId: context.workspace.id, worldId: context.world.id, sessionId: target.id,
      turnId: turn.id, employeeId, ordinal: index + 1,
    })
    store.startAgentRun(run.id)
    store.appendMessage({
      sessionId: target.id, senderId: employeeId, senderKind: 'employee', kind: 'assistant',
      content: '完成', metadata: { agentRunId: run.id, traceTurnId: run.id, workTurnId: turn.id },
    })
    return store.completeAgentRun(run.id, `runtime-${run.id}`)
  })
  store.completeWorkTurn(turn.id)
  return { turn, runs }
}

/** A WorkTask in `running`, the state WorkSystemService puts it in before the turn starts. */
function createTask(context: Fixture, title: string, worldId = context.world.id) {
  const repository = new WorkSystemRepository(context.store.database)
  let task = repository.createTask({
    workspaceId: context.workspace.id, worldId, title,
    description: '把任务目标真正挂到轨迹上', priority: 'normal', createdBy: 'owner',
  })
  task = repository.transitionTask(task.id, ['draft'], 'planning')
  task = repository.transitionTask(task.id, ['planning'], 'ready')
  task = repository.transitionTask(task.id, ['ready'], 'running')
  return { task, repository }
}

/**
 * A turn whose runs have started and not finished, seeded the way the
 * orchestrator seeds a task turn: one owner message carrying the host-written
 * `workTaskId` next to the turn id. Nothing in `task_runs` yet.
 */
function liveTurn(context: Fixture, target: WorkSession, employeeIds: string[], seed: Record<string, string>) {
  const { store } = context
  const turn = store.createWorkTurn({
    workspaceId: context.workspace.id, worldId: context.world.id, sessionId: target.id, interactionKind: 'task',
  })
  store.appendMessage({
    sessionId: target.id, senderId: 'owner', senderKind: 'owner', kind: 'user',
    content: '开始任务', metadata: { ...seed, workTurnId: turn.id, interactionKind: 'task' },
  })
  store.startWorkTurn(turn.id)
  const runs = employeeIds.map((employeeId, index) => {
    const run = store.createAgentRun({
      workspaceId: context.workspace.id, worldId: context.world.id, sessionId: target.id,
      turnId: turn.id, employeeId, ordinal: index + 1,
    })
    return store.startAgentRun(run.id)
  })
  return { turn, runs }
}

function finishTurn(context: Fixture, live: ReturnType<typeof liveTurn>) {
  const runs = live.runs.map((run) => context.store.completeAgentRun(run.id, `runtime-${run.id}`))
  context.store.completeWorkTurn(live.turn.id)
  return { turn: live.turn, runs }
}

/** Records the turn against a real WorkTask the way WorkSystemService does. */
function recordTask(context: Fixture, title: string, target: WorkSession, turnId: string, runs: AgentRun[]) {
  const { task, repository } = createTask(context, title)
  recordExecution(context, repository, task.id, target, turnId, runs)
  return { task, repository }
}

function recordExecution(context: Fixture, repository: WorkSystemRepository, taskId: string, target: WorkSession, turnId: string, runs: AgentRun[]) {
  const plan = context.store.createTaskCollaborationPlan({
    taskId: `task-${turnId}`,
    workspaceId: context.workspace.id,
    worldId: context.world.id,
    sessionId: target.id,
    workTurnId: turnId,
    status: 'completed',
    steps: [{ requiredSkills: [], assignedEmployeeIds: runs.map((run) => run.employeeId), dependsOn: [], executionMode: 'parallel', status: 'completed' }],
  })
  repository.recordExecution({ taskId, plan, agentRuns: runs, coordinatorEmployeeId: runs[0]!.employeeId, latency: 10 })
}

function snapshot(input: { memoryIds: string[]; identityTokens: number; requestTokens: number }): ContextSnapshot {
  return {
    snapshotVersion: 1,
    envelopeVersion: 1,
    stablePrefixHash: 'prefix-hash',
    structureHash: 'structure-hash',
    layers: [
      { id: 'identity', kind: 'stable-identity', revision: '1', contentHash: 'h1', tokenEstimate: input.identityTokens, sourceRefs: [{ kind: 'employee', id: 'employee' }] },
      { id: 'retrieved', kind: 'retrieved-memories', revision: 'h2', contentHash: 'h2', tokenEstimate: 90, sourceRefs: input.memoryIds.map((id) => ({ kind: 'memory' as const, id })) },
      { id: 'request', kind: 'current-request', revision: 'h3', contentHash: 'h3', tokenEstimate: input.requestTokens, sourceRefs: [{ kind: 'request', id: 'request' }] },
    ],
    totalTokenEstimate: input.identityTokens + 90 + input.requestTokens,
    cache: { stablePrefixTokens: input.identityTokens, volatileTokens: 90 + input.requestTokens, prefixReused: false },
  }
}

function service(context: Fixture) {
  return new WorldTraceService({
    store: context.store,
    actions: new MemoryActions(),
    tasks: new WorkSystemRepository(context.store.database),
    contexts: new ContextSnapshotService(context.store),
  })
}

describe('World Trace: 任务目标', () => {
  it('names the real task on a run recorded against it, and nothing on a plain chat run', async () => {
    const context = await fixture()
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const taskTurn = completedTurn(context, group, [context.alice.id, context.bob.id])
    const { task } = recordTask(context, '整理季度复盘', group, taskTurn.turn.id, taskTurn.runs)
    const direct = session(context, 'direct', [context.alice.id])
    const chat = completedTurn(context, direct, [context.alice.id])

    const page = await service(context).list(context.world.id, { limit: 200 })
    const runs = page.items.filter((item) => item.sourceKind === 'agent-run')
    expect(runs).toHaveLength(3)

    for (const run of taskTurn.runs) {
      const entry = runs.find((item) => item.runId === run.id)
      expect(entry, run.id).toMatchObject({ taskId: task.id, taskTitle: '整理季度复盘' })
    }
    const chatEntry = runs.find((item) => item.runId === chat.runs[0]!.id)!
    // No task means no task field: not a turn id, not a placeholder.
    expect(chatEntry).not.toHaveProperty('taskId')
    expect(chatEntry).not.toHaveProperty('taskTitle')
    expect(JSON.stringify(page)).not.toContain('turn:')
    const turnIds = new Set([chat.turn.id, taskTurn.turn.id])
    expect(page.items.some((item) => item.taskId !== undefined && turnIds.has(item.taskId))).toBe(false)
  })

  it('filters by task id and finds the task by its title', async () => {
    const context = await fixture()
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const taskTurn = completedTurn(context, group, [context.alice.id, context.bob.id])
    const { task } = recordTask(context, '迁移旧仓库', group, taskTurn.turn.id, taskTurn.runs)
    completedTurn(context, session(context, 'direct', [context.alice.id]), [context.alice.id])
    const trace = service(context)

    const byTask = await trace.list(context.world.id, { taskId: task.id })
    expect(byTask.items.map((item) => item.runId).sort()).toEqual(taskTurn.runs.map((run) => run.id).sort())
    expect((await trace.list(context.world.id, { taskId: 'no-such-task' })).items).toEqual([])
    const byTitle = await trace.list(context.world.id, { search: '旧仓库' })
    expect(byTitle.items.length).toBe(taskTurn.runs.length)
    expect(byTitle.items.every((item) => item.taskId === task.id)).toBe(true)
  })

  it('redacts a task title the same way it redacts every other displayed string', async () => {
    const context = await fixture()
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const taskTurn = completedTurn(context, group, [context.alice.id, context.bob.id])
    const { task } = recordTask(context, '轮换密钥 sk-1234567890123456 后同步', group, taskTurn.turn.id, taskTurn.runs)

    const page = await service(context).list(context.world.id, { taskId: task.id })
    expect(page.items.length).toBe(taskTurn.runs.length)
    expect(JSON.stringify(page)).not.toContain('sk-1234567890123456')
    expect(page.items[0]?.taskTitle).toContain('轮换密钥')
  })

  it('never names a task the world can no longer show', () => {
    const grouped = groupTasksByRun(
      [{ id: 'task-live', title: '在册任务' }],
      [
        { taskId: 'task-live', workTurnId: 'turn-1', agentRunIds: ['run-1'] },
        { taskId: 'task-gone', workTurnId: 'turn-2', agentRunIds: ['run-2'] },
      ],
    )
    expect(grouped.byRun.get('run-1')).toEqual({ id: 'task-live', title: '在册任务' })
    expect(grouped.byTurn.get('turn-1')).toEqual({ id: 'task-live', title: '在册任务' })
    expect(grouped.byRun.has('run-2')).toBe(false)
    expect(grouped.byTurn.has('turn-2')).toBe(false)
  })
})

describe('World Trace: 任务目标 — 运行中的窗口', () => {
  /**
   * `task_runs` is written only after the whole task turn completes, so the
   * durable link cannot exist while a run is live — exactly when the card is
   * being watched. In that window the trace trusts the host-written
   * `workTaskId` on the turn's seed message, but only once it resolves to a
   * `work_tasks` row of the same world.
   */
  it('names the task from the seed message while the run is live, and the durable link agrees once task_runs lands', async () => {
    const context = await fixture()
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const { task, repository } = createTask(context, '整理季度复盘')
    const live = liveTurn(context, group, [context.alice.id, context.bob.id], { workTaskId: task.id })
    const trace = service(context)

    const before = await trace.list(context.world.id, { limit: 200 })
    for (const run of live.runs) {
      const entry = before.items.find((item) => item.runId === run.id)
      expect(entry, run.id).toMatchObject({ status: 'running', taskId: task.id, taskTitle: '整理季度复盘' })
    }
    const filtered = await trace.list(context.world.id, { taskId: task.id })
    expect(filtered.items.map((item) => item.runId).sort()).toEqual(live.runs.map((run) => run.id).sort())

    const finished = finishTurn(context, live)
    recordExecution(context, repository, task.id, group, finished.turn.id, finished.runs)
    const after = await trace.list(context.world.id, { limit: 200 })
    for (const run of finished.runs) {
      const entry = after.items.find((item) => item.runId === run.id)
      expect(entry, run.id).toMatchObject({ status: 'success', taskId: task.id, taskTitle: '整理季度复盘' })
    }
  })

  it('treats a workTaskId that does not resolve, or resolves to another world, as no task', async () => {
    const context = await fixture()
    const elsewhere = context.store.createWorld({ workspaceId: context.workspace.id, name: '另一个世界', templateId: 'personal-world' })
    const foreign = createTask(context, '别处的任务', elsewhere.id).task
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const forged = liveTurn(context, group, [context.alice.id], { workTaskId: 'task-forged-0000' })
    const crossWorld = liveTurn(context, group, [context.bob.id], { workTaskId: foreign.id })

    const trace = service(context)
    const page = await trace.list(context.world.id, { limit: 200 })
    for (const run of [...forged.runs, ...crossWorld.runs]) {
      const entry = page.items.find((item) => item.runId === run.id)!
      expect(entry.status, run.id).toBe('running')
      expect(entry, run.id).not.toHaveProperty('taskId')
      expect(entry, run.id).not.toHaveProperty('taskTitle')
    }
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain('task-forged-0000')
    expect(serialized).not.toContain(foreign.id)
    expect(serialized).not.toContain('别处的任务')
    expect((await trace.list(context.world.id, { taskId: foreign.id })).items).toEqual([])
    // The other world does not inherit the run either: a hint never crosses worlds in either direction.
    expect((await trace.list(elsewhere.id, { limit: 200 })).items.filter((item) => item.sourceKind === 'agent-run')).toEqual([])
  })

  it('lets the durable task_runs link outrank a seed hint that disagrees with it', async () => {
    const context = await fixture()
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const recorded = createTask(context, '真正记录的任务')
    const hinted = createTask(context, '种子里写的任务').task
    const live = liveTurn(context, group, [context.alice.id, context.bob.id], { workTaskId: hinted.id })
    const trace = service(context)
    expect((await trace.list(context.world.id, { taskId: hinted.id })).items.length).toBe(live.runs.length)

    const finished = finishTurn(context, live)
    recordExecution(context, recorded.repository, recorded.task.id, group, finished.turn.id, finished.runs)
    const page = await trace.list(context.world.id, { limit: 200 })
    for (const run of finished.runs) {
      expect(page.items.find((item) => item.runId === run.id), run.id).toMatchObject({ taskId: recorded.task.id, taskTitle: '真正记录的任务' })
    }
    expect((await trace.list(context.world.id, { taskId: hinted.id })).items).toEqual([])
  })

  it('carries the verified task on the live card a runtime event produces, and nothing on a chat run or a forged seed', async () => {
    const context = await fixture()
    const group = session(context, 'group', [context.alice.id, context.bob.id])
    const { task } = createTask(context, '轮换密钥 sk-1234567890123456 后同步')
    const tasked = liveTurn(context, group, [context.alice.id], { workTaskId: task.id })
    const forged = liveTurn(context, group, [context.bob.id], { workTaskId: 'task-forged-0000' })
    const direct = session(context, 'direct', [context.alice.id])
    const chat = liveTurn(context, direct, [context.alice.id], {})
    const trace = service(context)
    const started = (turnId: string, run: AgentRun, sequence: number) => trace.adaptRuntime({
      workspaceId: context.workspace.id, worldId: context.world.id, sessionId: run.sessionId, agentId: run.employeeId,
      workTurnId: turnId, agentRunId: run.id,
      event: { kind: 'turn.started', source: 'trace-test', sourceSessionId: `runtime-${run.id}`, sourceSequence: sequence, metadata: {} },
    })

    const [liveTasked] = started(tasked.turn.id, tasked.runs[0]!, 1)
    expect(liveTasked).toMatchObject({ status: 'running', runId: tasked.runs[0]!.id, taskId: task.id })
    expect(liveTasked?.taskTitle).toContain('轮换密钥')
    expect(JSON.stringify(liveTasked)).not.toContain('sk-1234567890123456')
    // A later event on the same run keeps the link without being re-resolved.
    const [again] = trace.adaptRuntime({
      workspaceId: context.workspace.id, worldId: context.world.id, sessionId: tasked.runs[0]!.sessionId, agentId: context.alice.id,
      workTurnId: tasked.turn.id, agentRunId: tasked.runs[0]!.id,
      event: { kind: 'assistant.reasoning', source: 'trace-test', sourceSessionId: `runtime-${tasked.runs[0]!.id}`, sourceSequence: 2, content: '先看数据', metadata: {} },
    })
    expect(again).toMatchObject({ taskId: task.id })

    for (const [turnId, run] of [[forged.turn.id, forged.runs[0]!], [chat.turn.id, chat.runs[0]!]] as const) {
      const [entry] = started(turnId, run, 1)
      expect(entry, run.id).toMatchObject({ status: 'running', runId: run.id })
      expect(entry, run.id).not.toHaveProperty('taskId')
      expect(entry, run.id).not.toHaveProperty('taskTitle')
    }
    expect(JSON.stringify(await trace.list(context.world.id, { limit: 200 }))).not.toContain('task-forged-0000')
  })
})

describe('World Trace: 用了什么上下文', () => {
  it('carries the snapshot numbers of a run that has one and nothing for a run that has none', async () => {
    const context = await fixture()
    const direct = session(context, 'direct', [context.alice.id])
    const older = completedTurn(context, direct, [context.alice.id])
    const newer = completedTurn(context, direct, [context.alice.id])
    context.store.saveAgentRunContextSnapshot({
      agentRunId: newer.runs[0]!.id,
      snapshot: snapshot({ memoryIds: ['memory-1', 'memory-2', 'memory-1'], identityTokens: 320, requestTokens: 40 }),
    })

    const page = await service(context).list(context.world.id, { limit: 200 })
    const withSnapshot = page.items.find((item) => item.runId === newer.runs[0]!.id)!
    expect(withSnapshot.context).toEqual({
      totalTokenEstimate: 450,
      layers: [
        { kind: 'stable-identity', tokenEstimate: 320 },
        { kind: 'retrieved-memories', tokenEstimate: 90 },
        { kind: 'current-request', tokenEstimate: 40 },
      ],
      // Two distinct memory rows; the duplicate pointer is not a third hit.
      memoryHitCount: 2,
      stablePrefixTokens: 320,
      volatileTokens: 130,
      prefixReused: false,
    })
    // The summary is numbers only: no pointer, no hash, no text reaches the trace.
    expect(JSON.stringify(withSnapshot.context)).not.toContain('memory-1')
    expect(JSON.stringify(withSnapshot.context)).not.toContain('prefix-hash')

    const withoutSnapshot = page.items.find((item) => item.runId === older.runs[0]!.id)!
    expect(withoutSnapshot).not.toHaveProperty('context')
  })

  it('reports no context for any run when the store has no snapshot rows', async () => {
    const context = await fixture()
    const direct = session(context, 'direct', [context.alice.id])
    completedTurn(context, direct, [context.alice.id])
    const page = await service(context).list(context.world.id, { limit: 200 })
    expect(page.items.filter((item) => item.sourceKind === 'agent-run').every((item) => item.context === undefined)).toBe(true)
  })
})
