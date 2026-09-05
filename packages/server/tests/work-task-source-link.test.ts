import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { WorkSystemContractError, type EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import type { GroupTaskCollaborationService } from '../src/services/group-task-collaboration-service.js'
import { WorkSystemService } from '../src/services/work-system-service.js'

/**
 * The service entry point the conversation route will call once the intent
 * router decides a message is an instruction: hand it the turn the queue just
 * minted, get back the one task that turn owns — created now or found from an
 * earlier send, recovery pass or retry — never a duplicate and never an error
 * the UI cannot act on.
 */

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function open(path?: string): Promise<{ path: string; store: SqliteStore }> {
  const target = path ?? join(await mkdtemp(join(tmpdir(), 'dsh-cyber-task-source-service-')), 'cyber.sqlite')
  const store = await SqliteStore.open(target)
  stores.push(store)
  return { path: target, store }
}

/** createFromSource must only record the task; nothing may run because of it. */
const neverRuns = {
  run: async () => { throw new Error('createFromSource must not start a run') },
} as unknown as GroupTaskCollaborationService

function service(store: SqliteStore): WorkSystemService {
  return new WorkSystemService({ store, groupTasks: neverRuns })
}

interface Conversation { workspaceId: string; worldId: string; sessionId: string; employeeId: string }

function conversation(store: SqliteStore, name: string): Conversation {
  const workspace = store.createWorkspace({ name: `${name}工作区` })
  const world = store.createWorld({ workspaceId: workspace.id, name, templateId: 'cyber-company' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1, id: `test.${world.id}.assistant`, version: 1, worldTemplateId: 'cyber-company',
    displayName: `${name}助手`, role: '助理', summary: '任务来源测试角色', persona: '保持当前世界边界。',
    requestedSkills: [], requestedCapabilities: [], createdAt: '2026-09-04T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1 })
  const session = store.createSession({
    workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '私聊',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  return { workspaceId: workspace.id, worldId: world.id, sessionId: session.id, employeeId: employee.id }
}

function send(store: SqliteStore, context: Conversation, content: string) {
  const turn = store.createWorkTurn({ workspaceId: context.workspaceId, worldId: context.worldId, sessionId: context.sessionId, interactionKind: 'chat' })
  const message = store.appendMessage({
    sessionId: context.sessionId, senderId: 'owner', senderKind: 'owner', kind: 'user', content, metadata: { workTurnId: turn.id },
  })
  return { turn, message }
}

describe('WorkSystemService.createFromSource', () => {
  it('resolves the same turn to one task: sent twice, double-created, and again after a restart', async () => {
    const { path, store } = await open()
    const context = conversation(store, '来源世界')
    const { turn, message } = send(store, context, '请整理本周周报。')
    const work = service(store)
    const input = { worldId: context.worldId, workTurnId: turn.id, title: '整理本周周报', description: '请整理本周周报。' }

    const first = work.createFromSource(input)
    expect(first.created).toBe(true)
    expect(first.task).toMatchObject({
      worldId: context.worldId, status: 'draft', priority: 'normal', sourceWorkTurnId: turn.id, sourceMessageId: message.id,
    })
    expect(work.createFromSource(input)).toEqual({ created: false, task: first.task })

    // Two creates racing for the same turn — what a resend that overtakes the
    // first request looks like — still end on one task id.
    const raced = await Promise.all([
      Promise.resolve().then(() => work.createFromSource(input)),
      Promise.resolve().then(() => work.createFromSource(input)),
    ])
    expect(raced.map((result) => result.task.id)).toEqual([first.task.id, first.task.id])
    expect(raced.some((result) => result.created)).toBe(false)

    // Recovery after a restart replays the intent from the durable turn and
    // finds the task instead of minting another.
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const { store: reopened } = await open(path)
    const recovered = service(reopened).createFromSource(input)
    expect(recovered).toEqual({ created: false, task: first.task })
    expect(service(reopened).list(context.worldId).map((task) => task.id)).toEqual([first.task.id])
    expect(service(reopened).detail(first.task.id).task).toMatchObject({ sourceWorkTurnId: turn.id, sourceMessageId: message.id })
  })

  it('gives each turn its own task and honours the same limits as the task board', async () => {
    const { store } = await open()
    const context = conversation(store, '双回合世界')
    const first = send(store, context, '整理周报。')
    const second = send(store, context, '再写一封邮件。')
    const work = service(store)

    const a = work.createFromSource({ worldId: context.worldId, workTurnId: first.turn.id, title: '整理周报', description: '整理周报。' })
    const b = work.createFromSource({
      worldId: context.worldId, workTurnId: second.turn.id, title: '写一封邮件', description: '再写一封邮件。',
      priority: 'high', coordinatorEmployeeId: context.employeeId,
    })
    expect(a.task.id).not.toBe(b.task.id)
    expect(b.task).toMatchObject({ priority: 'high', coordinatorEmployeeId: context.employeeId, sourceWorkTurnId: second.turn.id })
    expect(work.list(context.worldId)).toHaveLength(2)

    expect(() => work.createFromSource({ worldId: context.worldId, workTurnId: second.turn.id, title: 'x'.repeat(161), description: '过长标题' }))
      .toThrow(WorkSystemContractError)
    expect(() => work.createFromSource({ worldId: context.worldId, workTurnId: second.turn.id, title: '缺少目标', description: '   ' }))
      .toThrow(WorkSystemContractError)
    expect(() => work.createFromSource({ worldId: context.worldId, workTurnId: first.turn.id, title: '陌生协调角色', description: '目标', coordinatorEmployeeId: 'nobody' }))
      .toThrow('任务角色不可用')
  })

  it('refuses a turn from another world or an archived world without creating anything', async () => {
    const { store } = await open()
    const home = conversation(store, '本世界')
    const elsewhere = conversation(store, '他世界')
    const foreign = send(store, elsewhere, '他世界的指令。')
    const work = service(store)

    expect(() => work.createFromSource({ worldId: home.worldId, workTurnId: foreign.turn.id, title: '跨世界', description: '他世界的指令。' }))
      .toThrow('来源回合不属于当前世界')
    expect(() => work.createFromSource({ worldId: home.worldId, workTurnId: 'missing', title: '未知回合', description: '目标' }))
      .toThrow('来源回合不存在')

    const own = send(store, home, '本世界的指令。')
    store.archiveWorld({ worldId: home.worldId })
    expect(() => work.createFromSource({ worldId: home.worldId, workTurnId: own.turn.id, title: '归档世界', description: '本世界的指令。' }))
      .toThrow('任务世界不可用')
    expect(work.list(home.worldId)).toEqual([])
    expect(work.list(elsewhere.worldId)).toEqual([])
  })
})
