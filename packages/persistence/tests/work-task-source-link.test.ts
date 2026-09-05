import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { EntityNotFoundError, PersistenceError, SqliteStore, WorkSystemRepository } from '../src/index.js'

/**
 * A task that grew out of a conversation is keyed by the WorkTurn that asked
 * for it. Resend, recovery and retry all share that turn id, so "one task per
 * turn" has to hold in the database itself — not only in the process that
 * happened to run the first create.
 */

const stores: SqliteStore[] = []
const connections: DatabaseSync[] = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const store of stores.splice(0)) store.close()
})

async function testDatabase(): Promise<{ path: string; store: SqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-task-source-'))
  const path = join(directory, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  return { path, store }
}

interface Conversation { workspaceId: string; worldId: string; sessionId: string; employeeId: string }

function conversation(store: SqliteStore, name: string): Conversation {
  const workspace = store.createWorkspace({ name: `${name}工作区` })
  const world = store.createWorld({ workspaceId: workspace.id, name, templateId: 'cyber-company' })
  const employee = recruit(store, workspace.id, world.id, `${name}助手`)
  const session = store.createSession({
    workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '私聊',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  return { workspaceId: workspace.id, worldId: world.id, sessionId: session.id, employeeId: employee.id }
}

/** What the orchestrator writes for one sent message: a turn and the owner message stamped with it. */
function send(store: SqliteStore, context: Conversation, content: string, clientTurnId?: string) {
  const turn = store.createWorkTurn({
    workspaceId: context.workspaceId, worldId: context.worldId, sessionId: context.sessionId, interactionKind: 'chat',
    ...(clientTurnId === undefined ? {} : { clientTurnId }),
  })
  const message = store.appendMessage({
    sessionId: context.sessionId, senderId: 'owner', senderKind: 'owner', kind: 'user', content,
    metadata: { workTurnId: turn.id, ...(clientTurnId === undefined ? {} : { clientTurnId }) },
  })
  return { turn, message }
}

function draft(context: Conversation, workTurnId: string, overrides: Partial<{ title: string; description: string }> = {}) {
  return {
    workspaceId: context.workspaceId, worldId: context.worldId, workTurnId,
    title: '整理本周周报', description: '把本周的会议纪要整理成一页周报。', priority: 'normal' as const, createdBy: 'owner',
    ...overrides,
  }
}

describe('WorkTask source link', () => {
  it('creates one task per source turn and hands the same task back on a resend', async () => {
    const { store } = await testDatabase()
    const context = conversation(store, '来源世界')
    const repository = new WorkSystemRepository(store.database)
    const { turn, message } = send(store, context, '请整理本周周报。', 'client-turn-1')

    const first = repository.createTaskFromSource(draft(context, turn.id))
    expect(first.created).toBe(true)
    expect(first.task).toMatchObject({
      status: 'draft', title: '整理本周周报', sourceWorkTurnId: turn.id, sourceMessageId: message.id, createdBy: 'owner',
    })

    // A resend carries the same turn: the existing task comes back untouched,
    // even when the caller derived a slightly different title this time.
    const again = repository.createTaskFromSource(draft(context, turn.id, { title: '整理周报（重发）' }))
    expect(again.created).toBe(false)
    expect(again.task).toEqual(first.task)
    expect(repository.getTaskBySourceWorkTurn(turn.id)).toEqual(first.task)
    expect(repository.listTasks(context.worldId).map((task) => task.id)).toEqual([first.task.id])
    expect(repository.detail(first.task.id).task).toEqual(first.task)
  })

  it('gives a different turn its own task', async () => {
    const { store } = await testDatabase()
    const context = conversation(store, '双回合世界')
    const repository = new WorkSystemRepository(store.database)
    const first = send(store, context, '整理周报。')
    const second = send(store, context, '再写一封邮件。')

    const a = repository.createTaskFromSource(draft(context, first.turn.id))
    const b = repository.createTaskFromSource(draft(context, second.turn.id, { title: '写一封邮件' }))
    expect(a.created && b.created).toBe(true)
    expect(a.task.id).not.toBe(b.task.id)
    expect(b.task).toMatchObject({ sourceWorkTurnId: second.turn.id, sourceMessageId: second.message.id })
    expect(repository.listTasks(context.worldId)).toHaveLength(2)
  })

  it('is enforced by the database when the application check is bypassed', async () => {
    const { store } = await testDatabase()
    const context = conversation(store, '直写世界')
    const repository = new WorkSystemRepository(store.database)
    const { turn, message } = send(store, context, '整理周报。')
    repository.createTaskFromSource(draft(context, turn.id))

    const now = new Date().toISOString()
    expect(() => store.database.prepare(
      `INSERT INTO work_tasks
       (id, workspace_id, world_id, title, description, status, priority, due_at, budget_json,
        created_by, coordinator_employee_id, current_plan_revision, created_at, updated_at,
        source_work_turn_id, source_message_id)
       VALUES ('bypass', ?, ?, '绕过应用层', '直接写库', 'draft', 'normal', NULL, '{}', 'owner', NULL, 0, ?, ?, ?, ?)`,
    ).run(context.workspaceId, context.worldId, now, now, turn.id, message.id))
      .toThrow(/UNIQUE constraint failed: work_tasks\.source_work_turn_id/)
    expect(repository.listTasks(context.worldId)).toHaveLength(1)
  })

  it('converges two connections that cannot see each other on one task', async () => {
    const { path, store } = await testDatabase()
    const context = conversation(store, '并发世界')
    const { turn } = send(store, context, '整理周报。')
    const mine = new WorkSystemRepository(store.database)

    // A second connection has no memory of what the first one did: only the
    // unique index can tell it the turn is already taken.
    const other = new DatabaseSync(path)
    connections.push(other)
    other.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
    const theirs = new WorkSystemRepository(other)

    const first = theirs.createTaskFromSource(draft(context, turn.id))
    const second = mine.createTaskFromSource(draft(context, turn.id))
    expect([first.created, second.created]).toEqual([true, false])
    expect(second.task.id).toBe(first.task.id)
    expect(store.database.prepare('SELECT COUNT(*) AS count FROM work_tasks WHERE source_work_turn_id = ?').get(turn.id))
      .toMatchObject({ count: 1 })
  })

  it('leaves tasks without a source alone, however many there are', async () => {
    const { store } = await testDatabase()
    const context = conversation(store, '看板世界')
    const repository = new WorkSystemRepository(store.database)
    const plain = { workspaceId: context.workspaceId, worldId: context.worldId, title: '看板任务', description: '从任务看板创建。', priority: 'normal' as const, createdBy: 'owner' }
    const a = repository.createTask(plain)
    const b = repository.createTask(plain)
    expect(a.id).not.toBe(b.id)
    expect(a).not.toHaveProperty('sourceWorkTurnId')
    expect(a).not.toHaveProperty('sourceMessageId')
    expect(repository.listTasks(context.worldId)).toHaveLength(2)
  })

  it('refuses a turn it cannot vouch for: unknown, from another world, or without an owner message', async () => {
    const { store } = await testDatabase()
    const home = conversation(store, '本世界')
    const elsewhere = conversation(store, '他世界')
    const repository = new WorkSystemRepository(store.database)
    const foreign = send(store, elsewhere, '他世界的消息。')
    const silent = store.createWorkTurn({ workspaceId: home.workspaceId, worldId: home.worldId, sessionId: home.sessionId, interactionKind: 'peer' })
    store.appendMessage({ sessionId: home.sessionId, senderId: 'system', senderKind: 'system', kind: 'system', content: '角色协作目标：无', metadata: { workTurnId: silent.id } })

    expect(() => repository.createTaskFromSource(draft(home, 'missing-turn'))).toThrow(EntityNotFoundError)
    expect(() => repository.createTaskFromSource(draft(home, foreign.turn.id))).toThrow(PersistenceError)
    expect(() => repository.createTaskFromSource(draft(home, foreign.turn.id))).toThrow(/world/)
    expect(() => repository.createTaskFromSource(draft(home, silent.id))).toThrow(/owner message/)
    expect(repository.listTasks(home.worldId)).toEqual([])
    expect(repository.listTasks(elsewhere.worldId)).toEqual([])
  })

  it('keeps the task and its message reference when the settled source turn is pruned', async () => {
    const { store } = await testDatabase()
    const context = conversation(store, '清理世界')
    const repository = new WorkSystemRepository(store.database)
    const { turn, message } = send(store, context, '整理周报。')
    const { task } = repository.createTaskFromSource(draft(context, turn.id))
    store.startWorkTurn(turn.id)
    store.completeWorkTurn(turn.id)

    const pruned = store.pruneHistory({ before: '2999-01-01T00:00:00.000Z' })
    expect(pruned.workTurns).toBeGreaterThanOrEqual(1)
    expect(store.getWorkTurn(turn.id)).toBeUndefined()

    // The transcript is not the work fact: the task survives, the turn link is
    // released, and the message (never pruned) is still the recorded source.
    const survivor = repository.getTask(task.id)
    expect(survivor).toMatchObject({ id: task.id, title: task.title, sourceMessageId: message.id })
    expect(survivor).not.toHaveProperty('sourceWorkTurnId')
    expect(repository.getTaskBySourceWorkTurn(turn.id)).toBeUndefined()
    expect(store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

function recruit(store: SqliteStore, workspaceId: string, worldId: string, displayName: string) {
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: `test.${worldId}.${displayName}`,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role: '协作角色',
    summary: '任务来源测试角色',
    persona: '保持当前世界边界。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-09-04T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  return store.recruitEmployee({ workspaceId, worldId, blueprintId: blueprint.id, blueprintVersion: 1, displayName })
}
