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
    store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'turn.started',
      actorId: employee.id,
      actorKind: 'employee',
      payload: { source: 'test', sourceSessionId: 'runtime-1', sourceSequence: 1 },
    })
    store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'turn.completed',
      actorId: employee.id,
      actorKind: 'employee',
      payload: { source: 'test', sourceSessionId: 'runtime-1', sourceSequence: 2 },
    })
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
    expect(all.items.filter((item) => item.summary.includes('本轮处理'))).toHaveLength(1)
    expect(all.items.find((item) => item.summary.includes('本轮处理'))?.status).toBe('success')
    expect(JSON.stringify(all)).not.toContain('这是完整提示词')
    expect((await service.list(world.id, { category: 'skill' })).items).toEqual([
      expect.objectContaining({ category: 'skill', status: 'success', skillId: 'lights' }),
    ])
    expect((await service.list(world.id, { status: 'success', actorId: employee.id })).items.every((item) => item.status === 'success' && item.actorId === employee.id)).toBe(true)
    expect((await service.list(world.id, { actorId: 'missing-actor' })).items).toEqual([])

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

  it('keeps lifecycle updates stable within a turn and distinct across turns', async () => {
    const { store, workspace, world, session, employee } = await fixture()
    for (const traceTurnId of ['turn-1', 'turn-2']) {
      store.appendDomainEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        sessionId: session.id,
        type: 'turn.started',
        actorId: employee.id,
        actorKind: 'employee',
        payload: { source: 'test', sourceSessionId: 'shared-runtime-session', sourceSequence: 1, traceTurnId },
      })
      store.appendDomainEvent({
        workspaceId: workspace.id,
        worldId: world.id,
        sessionId: session.id,
        type: 'turn.completed',
        actorId: employee.id,
        actorKind: 'employee',
        payload: { source: 'test', sourceSessionId: 'shared-runtime-session', sourceSequence: 2, traceTurnId },
      })
    }
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const turns = (await service.list(world.id, { category: 'agent', actorId: employee.id, limit: 200 })).items
      .filter((entry) => entry.summary.includes('本轮处理'))
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
    const { store, workspace, world, session, employee } = await fixture()
    const service = new WorldTraceService({ store, actions: new MemoryActions() })
    const checkpoint = await service.checkpoint(world.id)
    store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'task.started',
      actorId: employee.id,
      actorKind: 'employee',
    })
    store.appendDomainEvent({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      type: 'task.completed',
      actorId: employee.id,
      actorKind: 'employee',
    })
    const changes = await service.changesSince(world.id, checkpoint)
    expect(changes.filter((entry) => entry.taskId !== undefined)).toEqual([
      expect.objectContaining({ category: 'task', status: 'success', summary: '真实任务已完成' }),
    ])
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
