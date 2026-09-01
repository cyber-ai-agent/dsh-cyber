import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'
import { memoryIndexTerms } from '../src/employee-memory-index-repository.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'memory.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小刘',
    role: '内容员工',
    summary: '负责测试长期记忆',
    persona: '你只引用自己真实参与过的经历。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-index-'))
  const path = join(root, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '记忆世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'memory.worker',
    blueprintVersion: 1,
  })
  const session = store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: '私聊',
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
    ],
  })
  return { root, path, store, workspace, world, employee, session }
}

describe('employee memory index', () => {
  it('relocates the original messages and artifacts from a memory id', async () => {
    const { store, employee, session } = await setup()
    const question = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '把结算脚本 SettleJob 的重试改成三次。',
      metadata: {},
    })
    const answer = store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '已经改成三次并补了回归测试。',
      metadata: {},
    })
    const milestone = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'task',
      title: '[task] 任务经历',
      summary: '把结算脚本 SettleJob 的重试改成三次，并补了回归测试。',
      sourceMessageIds: [question.id, answer.id],
      artifactRefs: ['artifact:settle-job-notes'],
      actorId: 'system',
    })

    const entry = store.indexEmployeeMemory({
      memoryId: milestone.id,
      scope: 'task',
      keywords: memoryIndexTerms(milestone.summary),
      entities: ['SettleJob'],
      importance: 0.7,
    })

    // The index is a pointer, never the only copy: the memory id must lead
    // back to the durable messages and the artifact.
    expect(entry.memoryId).toBe(milestone.id)
    expect(store.getEmployeeMemoryIndexEntry(milestone.id)).toEqual(entry)
    expect(entry.sourceMessageIds).toEqual([question.id, answer.id])
    expect(entry.artifactRefs).toEqual(['artifact:settle-job-notes'])

    const messages = store.listMessages(session.id)
    const relocated = entry.sourceMessageIds.map((id) => messages.find((message) => message.id === id))
    expect(relocated.map((message) => message?.content)).toEqual([
      '把结算脚本 SettleJob 的重试改成三次。',
      '已经改成三次并补了回归测试。',
    ])

    // Dropping the whole derived index loses no fact.
    store.database.exec('DELETE FROM employee_memory_index')
    expect(store.getEmployeeMemoryIndexEntry(milestone.id)).toBeUndefined()
    expect(store.listEmployeeMilestones(employee.id).map((item) => item.id)).toContain(milestone.id)
    const rebuilt = store.indexEmployeeMemory({
      memoryId: milestone.id,
      scope: 'task',
      updatedAt: entry.updatedAt,
      keywords: entry.keywords,
      entities: entry.entities,
      importance: entry.importance,
    })
    expect(rebuilt).toEqual(entry)
  })

  it('never returns a private memory to a group query', async () => {
    const { store, workspace, world, employee, session } = await setup()
    const secret = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '我下周要提离职，先别说。',
      metadata: {},
    })
    const privateMilestone = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'reflection',
      title: '[private] 私聊记忆',
      summary: '用户说下周要提离职，暂时保密。',
      sourceMessageIds: [secret.id],
      actorId: 'system',
    })
    store.indexEmployeeMemory({
      memoryId: privateMilestone.id,
      scope: 'private',
      keywords: memoryIndexTerms('用户说下周要提离职，暂时保密。'),
    })

    const group = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '项目群',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const shared = store.appendMessage({
      sessionId: group.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '离职交接文档谁写？',
      metadata: {},
    })
    const groupMilestone = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'reflection',
      title: '[group] 群聊协作',
      summary: '在项目群里认领了离职交接文档。',
      sourceMessageIds: [shared.id],
      actorId: 'system',
    })
    store.indexEmployeeMemory({
      memoryId: groupMilestone.id,
      scope: 'group',
      keywords: memoryIndexTerms('在项目群里认领了离职交接文档。'),
    })

    const groupHits = store.searchEmployeeMemoryIndex({
      employeeId: employee.id,
      query: '离职',
      scopes: ['group', 'task'],
    })
    expect(groupHits.map((hit) => hit.entry.memoryId)).toEqual([groupMilestone.id])

    // The private episode is still durable and still reachable from the direct
    // conversation that produced it.
    const directHits = store.searchEmployeeMemoryIndex({
      employeeId: employee.id,
      query: '离职',
      scopes: ['private', 'group', 'task'],
    })
    expect(directHits.map((hit) => hit.entry.memoryId)).toContain(privateMilestone.id)
    expect(store.listEmployeeMemoryIndex(employee.id, ['group', 'task']).map((entry) => entry.memoryId))
      .toEqual([groupMilestone.id])
  })

  it('ranks a matching old episode above an unrelated recent one', async () => {
    const { store, employee, session } = await setup()
    const message = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '结算脚本',
      metadata: {},
    })
    const old = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'task',
      title: '[task] 任务经历',
      summary: '重构了结算脚本 SettleJob 的重试策略。',
      sourceMessageIds: [message.id],
      occurredAt: '2025-01-05T10:00:00.000Z',
      actorId: 'system',
    })
    const recent = store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'task',
      title: '[task] 任务经历',
      summary: '整理了前台海报的配色。',
      sourceMessageIds: [message.id],
      occurredAt: '2026-08-29T10:00:00.000Z',
      actorId: 'system',
    })
    store.indexEmployeeMemory({ memoryId: old.id, scope: 'task', keywords: memoryIndexTerms('重构了结算脚本 SettleJob 的重试策略。'), entities: ['SettleJob'], importance: 0.7 })
    store.indexEmployeeMemory({ memoryId: recent.id, scope: 'task', keywords: memoryIndexTerms('整理了前台海报的配色。'), importance: 0.4 })

    const hits = store.searchEmployeeMemoryIndex({ employeeId: employee.id, query: 'SettleJob 结算脚本', scopes: ['task'] })
    expect(hits[0]?.entry.memoryId).toBe(old.id)
    expect(hits[0]?.matchedEntities).toContain('settlejob')

    // With no lexical signal at all the index falls back to recency, so a
    // conversation never loses continuity entirely.
    const vague = store.searchEmployeeMemoryIndex({ employeeId: employee.id, query: '还记得吗', scopes: ['task'] })
    expect(vague[0]?.entry.memoryId).toBe(recent.id)
  })

  it('rejects an index entry that has no durable milestone behind it', async () => {
    const { store } = await setup()
    expect(() => store.indexEmployeeMemory({ memoryId: 'missing-milestone', scope: 'group' }))
      .toThrow(/durable milestone/)
  })
})
