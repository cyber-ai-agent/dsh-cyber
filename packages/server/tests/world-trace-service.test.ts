import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { ScheduledRunTraceFact } from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import { SqliteStore } from '@dsh-cyber/persistence'

import { WorldTraceService, decodeTraceCursor } from '../src/services/world-trace-service.js'
import type { CharacterSkillActionRepository } from '../src/skills/skill-action-repository.js'
import {
  ScheduleTraceAdapter,
  TraceSanitizer,
  WorldTraceAdapterRegistry,
} from '../src/world-trace/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

class MemoryActions implements CharacterSkillActionRepository {
  constructor(readonly items: CharacterSkillAction[] = []) {}
  async reserve(action: CharacterSkillAction) { return { action, created: true } }
  async save(): Promise<void> {}
  async listByWorld(worldId: string) { return this.items.filter((item) => item.worldId === worldId) }
  async listDue(): Promise<CharacterSkillAction[]> { return [] }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-trace-'))
  const store = await SqliteStore.open(join(root, 'trace.sqlite'))
  stores.push(store)
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
  const workspace = store.createWorkspace({ name: '轨迹测试' })
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
  return { store, workspace, world, session, employee }
}

function completeAgentRun(store: SqliteStore, context: Awaited<ReturnType<typeof fixture>>, reasoning = '先核对事实，再执行工具。') {
  const turn = store.createWorkTurn({
    workspaceId: context.workspace.id, worldId: context.world.id, sessionId: context.session.id, interactionKind: 'chat',
  })
  store.startWorkTurn(turn.id)
  const run = store.createAgentRun({
    workspaceId: context.workspace.id, worldId: context.world.id, sessionId: context.session.id,
    turnId: turn.id, employeeId: context.employee.id, ordinal: 1,
  })
  store.startAgentRun(run.id)
  store.appendMessage({
    sessionId: context.session.id, senderId: context.employee.id, senderKind: 'employee', kind: 'reasoning',
    content: reasoning, metadata: { agentRunId: run.id, traceTurnId: run.id },
  })
  store.appendMessage({
    sessionId: context.session.id, senderId: context.employee.id, senderKind: 'employee', kind: 'tool-call',
    content: 'search', metadata: { agentRunId: run.id, traceTurnId: run.id, callId: `call-${run.id}`, toolName: 'search' },
  })
  store.appendMessage({
    sessionId: context.session.id, senderId: context.employee.id, senderKind: 'employee', kind: 'tool-result',
    content: '已完成', metadata: { agentRunId: run.id, traceTurnId: run.id, callId: `call-${run.id}`, failed: false },
  })
  store.completeAgentRun(run.id, `runtime-${run.id}`)
  store.completeWorkTurn(turn.id)
  return run
}

describe('World Trace projection', () => {
  it('merges lifecycle updates into stable ids, filters, and paginates canonical facts', async () => {
    const { store, workspace, world, session, employee } = await fixture()
    store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '这是完整提示词，不应该进入轨迹详情',
      metadata: { participantIds: [employee.id] },
    })
    completeAgentRun(store, { store, workspace, world, session, employee })
    const actions = new MemoryActions([{
      id: 'action-1',
      worldId: world.id,
      characterId: employee.id,
      skillId: 'lights',
      adapterId: 'home',
      action: 'turn-on',
      target: 'office',
      label: '打开办公室灯光',
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {},
      status: 'executed',
      detail: '执行成功',
      createdAt: '2026-08-23T01:00:00.000Z',
      updatedAt: '2026-08-23T01:00:01.000Z',
    }])
    const service = new WorldTraceService({ store, actions })

    const all = await service.list(world.id, { limit: 200 })
    expect(all.items.filter((item) => item.sourceKind === 'agent-run')).toHaveLength(1)
    expect(all.items.find((item) => item.sourceKind === 'agent-run')).toMatchObject({
      status: 'success', reasoningSummary: '先核对事实，再执行工具。', tools: [expect.objectContaining({ status: 'success' })],
    })
    expect(JSON.stringify(all)).not.toContain('这是完整提示词')
    expect((await service.list(world.id, { category: 'skill' })).items).toEqual([
      expect.objectContaining({ category: 'skill', status: 'success', skillId: 'lights' }),
    ])
    expect((await service.list(world.id, { status: 'success', actorId: employee.id })).items.every((item) => item.status === 'success' && item.actorId === employee.id)).toBe(true)
    expect((await service.list(world.id, { actorId: 'missing-actor' })).items).toEqual([])
    expect((await service.list(world.id, { search: '核对事实' })).items).toEqual([
      expect.objectContaining({ sourceKind: 'agent-run', actorId: employee.id }),
    ])
    expect((await service.list(world.id, { search: '测试角色' })).items.some((item) => item.actorId === employee.id)).toBe(true)
    const runEntry = all.items.find((item) => item.sourceKind === 'agent-run')!
    const runDate = new Date(runEntry.createdAt)
    const localDate = `${runDate.getFullYear()}-${String(runDate.getMonth() + 1).padStart(2, '0')}-${String(runDate.getDate()).padStart(2, '0')}`
    expect((await service.list(world.id, { date: localDate })).items).toContainEqual(expect.objectContaining({ id: runEntry.id }))

    const first = await service.list(world.id, { limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeTypeOf('string')
    expect(decodeTraceCursor(first.nextCursor!)).toMatchObject({ id: first.items[0]!.id })
    const second = await service.list(world.id, { limit: 20, after: first.nextCursor })
    expect(second.items.some((item) => item.id === first.items[0]!.id)).toBe(false)
  })

  it('uses the same stable id for live and durable runtime facts', async () => {
    const { store, workspace, world, session, employee } = await fixture()
    store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'tool.started',
      actorId: employee.id,
      actorKind: 'employee',
      payload: { source: 'test', sourceSessionId: 'runtime-1', sourceSequence: 4, callId: 'call-1', toolName: 'search', traceTurnId: 'turn-1' },
    })
    const service = new WorldTraceService({
      store,
      actions: new MemoryActions(),
      clock: () => '2026-08-23T01:00:00.000Z',
    })
    const live = service.adaptRuntime({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      agentId: employee.id,
      workTurnId: 'work-turn-1',
      agentRunId: 'turn-1',
      event: {
        kind: 'tool.started',
        source: 'test',
        sourceSessionId: 'runtime-1',
        sourceSequence: 4,
        callId: 'call-1',
        toolName: 'search',
        metadata: { traceTurnId: 'turn-1' },
      },
    })
    const history = await service.list(world.id, { category: 'tool' })
    expect(live[0]?.id).toBe(history.items[0]?.id)
  })

  it('keeps the readable tool meaning when completion events omit the tool name', async () => {
    const { store, workspace, world, session, employee } = await fixture()
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const base = {
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      agentId: employee.id,
      workTurnId: 'work-turn-tool-meaning',
      agentRunId: 'run-tool-meaning',
    }
    service.adaptRuntime({
      ...base,
      event: { kind: 'tool.started', source: 'test', sourceSessionId: 'runtime-tool-meaning', sourceSequence: 1, callId: 'call-tool-meaning', toolName: 'exec_command', metadata: {} },
    })
    const completed = service.adaptRuntime({
      ...base,
      event: { kind: 'tool.completed', source: 'test', sourceSessionId: 'runtime-tool-meaning', sourceSequence: 2, callId: 'call-tool-meaning', failed: false, metadata: {} },
    })[0]

    expect(completed?.tools?.[0]).toMatchObject({
      name: 'exec_command',
      label: '执行本地命令',
      description: '在当前权限范围内运行命令或开发工具',
      status: 'success',
    })
  })

  it('keeps lifecycle updates stable within a turn and distinct across turns', async () => {
    const context = await fixture()
    const { store, workspace, world, session, employee } = context
    completeAgentRun(store, context, '第一轮判断摘要')
    completeAgentRun(store, context, '第二轮判断摘要')
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const turns = (await service.list(world.id, { actorId: employee.id, limit: 200 })).items
      .filter((entry) => entry.sourceKind === 'agent-run')
    expect(turns).toHaveLength(2)
    expect(new Set(turns.map((entry) => entry.id)).size).toBe(2)
    expect(turns.every((entry) => entry.status === 'success')).toBe(true)

    for (const meetingRunId of ['meeting-1', 'meeting-2']) {
      store.appendDomainEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        sessionId: session.id,
        type: 'meeting.started',
        actorId: 'owner',
        actorKind: 'owner',
        payload: { meetingRunId },
      })
      store.appendDomainEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        sessionId: session.id,
        type: 'meeting.finished',
        actorId: 'system',
        actorKind: 'system',
        payload: { meetingRunId, status: 'completed' },
      })
    }
    const meetings = (await service.list(world.id, { category: 'collaboration', limit: 200 })).items
      .filter((entry) => entry.summary.includes('多人协作'))
    expect(meetings).toHaveLength(2)
    expect(new Set(meetings.map((entry) => entry.id)).size).toBe(2)
    expect(meetings.every((entry) => entry.status === 'success')).toBe(true)
  })

  it('returns only new or updated durable facts after a live checkpoint', async () => {
    const context = await fixture()
    const { store, world } = context
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const checkpoint = await service.checkpoint(world.id)
    completeAgentRun(store, context)
    const changes = await service.changesSince(world.id, checkpoint)
    expect(changes.filter((entry) => entry.sourceKind === 'agent-run')).toEqual([
      expect.objectContaining({ status: 'success', reasoningSummary: '先核对事实，再执行工具。' }),
    ])
  })

  it('projects a failed knowledge consolidation job into the world trace', async () => {
    const { store, workspace, world } = await fixture()
    store.database.prepare(
      `INSERT INTO knowledge_consolidation_jobs
       (id, workspace_id, world_id, source_type, source_id, from_cursor, to_cursor, status, attempt, error_code, created_at, updated_at)
       VALUES ('job-x', ?, ?, 'conversation', 'session-x', 0, 5, 'failed', 2, 'knowledge_model_timeout', ?, ?)`,
    ).run(workspace.id, world.id, '2026-09-01T00:00:00.000Z', '2026-09-01T00:01:00.000Z')
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const page = await service.list(world.id)
    expect(page.items).toContainEqual(expect.objectContaining({
      category: 'system',
      status: 'failed',
      sourceKind: 'consolidation',
      sourceId: 'job-x',
      summary: '知识整理失败：模型响应超时',
    }))
  })

  it('reuses the cached projection while the watermark holds and rebuilds after facts change', async () => {
    const context = await fixture()
    const { store, world } = context
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const realMessages = store.listWorldTraceMessages.bind(store)
    let reads = 0
    store.listWorldTraceMessages = (worldId: string) => { reads += 1; return realMessages(worldId) }
    await service.list(world.id)
    await service.list(world.id)
    await service.checkpoint(world.id)
    // Several reads of an unchanged world must cost one projection, not one
    // per list/checkpoint/changesSince round trip.
    expect(reads).toBe(1)
    completeAgentRun(store, context)
    const page = await service.list(world.id)
    expect(reads).toBe(2)
    expect(page.items.some((entry) => entry.sourceKind === 'agent-run')).toBe(true)
  })

  it('rebuilds the cached projection when a run changes status without adding messages', async () => {
    const context = await fixture()
    const { store, world, session, employee } = context
    const turn = store.createWorkTurn({
      workspaceId: context.workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })
    store.startWorkTurn(turn.id)
    const run = store.createAgentRun({
      workspaceId: context.workspace.id,
      worldId: world.id,
      sessionId: session.id,
      turnId: turn.id,
      employeeId: employee.id,
      ordinal: 1,
    })
    store.startAgentRun(run.id)
    const service = new WorldTraceService({ store, actions: new MemoryActions() })

    expect((await service.list(world.id)).items).toContainEqual(expect.objectContaining({ runId: run.id, status: 'running' }))
    store.failAgentRun(run.id, 'model-timeout')
    expect((await service.list(world.id)).items).toContainEqual(expect.objectContaining({ runId: run.id, status: 'failed' }))
  })
})

describe('TraceSanitizer and adapter boundary', () => {
  it('redacts credentials recursively and from free text', () => {
    const sanitizer = new TraceSanitizer()
    const result = sanitizer.json({
      authorization: 'Bearer private-value',
      nested: { apiKey: 'sk-super-secret-value', note: 'token=private-token' },
    })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(JSON.stringify(result)).not.toContain('sk-super')
    expect(JSON.stringify(result)).toContain('已隐藏敏感信息')
  })

  it('accepts a future scheduler fixture without scheduler-specific core logic', () => {
    const registry = new WorldTraceAdapterRegistry()
    registry.register(new ScheduleTraceAdapter())
    const fact: ScheduledRunTraceFact = {
      id: 'future-fact-1',
      worldId: 'world-1',
      scheduleId: 'schedule-1',
      runId: 'run-1',
      status: 'success',
      summary: '晨间例行任务已完成',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:01:00.000Z',
    }
    const entries = registry.adapt({ kind: 'scheduled-run', value: fact }, {
      sanitizer: new TraceSanitizer(),
      actorName: () => undefined,
    })
    expect(entries).toEqual([expect.objectContaining({ category: 'schedule', scheduleId: 'schedule-1', runId: 'run-1' })])
  })
})
