import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { EmployeeConversationMemoryService } from '../src/services/employee-conversation-memory-service.js'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-employee-memory-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
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
  return { store, workspace, world, employee, memory: new EmployeeConversationMemoryService(store) }
}

describe('EmployeeConversationMemoryService', () => {
  it('stores a completed private turn only in the participating employee dossier and deduplicates retries', async () => {
    const { store, workspace, world, employee, memory } = await setup()
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
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
    const user = store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '以后写产品文案要克制一点',
      metadata: { workTurnId: turn.id },
    })
    const assistant = store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '记住了，后续会保持简洁克制。',
      metadata: { workTurnId: turn.id, agentRunId: 'run-private-1' },
    })

    const first = await memory.rememberCompletedRun({
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: 'run-private-1',
    })
    const duplicate = await memory.rememberCompletedRun({
      employeeId: employee.id,
      sessionId: session.id,
      workTurnId: turn.id,
      agentRunId: 'run-private-1',
    })

    expect(first?.title).toBe('[private] 私聊记忆')
    expect(first?.sourceMessageIds).toEqual(expect.arrayContaining([user.id, assistant.id]))
    expect(duplicate).toBeUndefined()
    expect(store.getEmployeeDossier(employee.id).milestones.filter((item) => item.title === '[private] 私聊记忆')).toHaveLength(1)
  })

  it('uses private memory in the employee direct chat but does not inject it into a group', async () => {
    const { store, workspace, world, employee, memory } = await setup()
    const direct = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [{ participantId: employee.id, kind: 'employee' }],
    })
    const group = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '发布群',
      participants: [{ participantId: employee.id, kind: 'employee' }],
    })
    const privateEvidence = store.appendMessage({
      sessionId: direct.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: '内部代号是蓝鲸',
      metadata: {},
    })
    const groupEvidence = store.appendMessage({
      sessionId: group.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '我来负责整理上线检查表',
      metadata: {},
    })
    store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'reflection',
      title: '[private] 私聊记忆',
      summary: '用户私下要求：内部代号为蓝鲸，不应主动告诉群里其他人。',
      sourceMessageIds: [privateEvidence.id],
      actorId: 'system',
    })
    store.appendEmployeeMilestone({
      employeeId: employee.id,
      category: 'reflection',
      title: '[group] 群聊协作',
      summary: '在发布群里负责整理上线检查表。',
      sourceMessageIds: [groupEvidence.id],
      actorId: 'system',
    })

    const directContext = await memory.compose({ employeeId: employee.id, conversationId: direct.id, prompt: '蓝鲸代号是什么？' })
    const groupContext = await memory.compose({ employeeId: employee.id, conversationId: group.id, prompt: '说下发布检查表和蓝鲸代号' })

    expect(directContext).toContain('蓝鲸')
    expect(groupContext).toContain('上线检查表')
    expect(groupContext).not.toContain('蓝鲸')
  })

  it('records only a character that actually produced a group AgentRun result', async () => {
    const { store, workspace, world, employee, memory } = await setup()
    const silent = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'memory.worker',
      blueprintVersion: 1,
      displayName: '旁听者',
    })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '项目群',
      participants: [
        { participantId: employee.id, kind: 'employee' },
        { participantId: silent.id, kind: 'employee' },
      ],
    })
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'meeting' })
    store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '只让小刘检查这个发布计划', metadata: { workTurnId: turn.id } })
    store.appendMessage({ sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '已完成发布检查。', metadata: { workTurnId: turn.id, agentRunId: 'run-group-1' } })

    await memory.rememberCompletedRun({ employeeId: employee.id, sessionId: session.id, workTurnId: turn.id, agentRunId: 'run-group-1' })

    expect(store.getEmployeeDossier(employee.id).milestones.some((item) => item.title === '[group] 群聊协作')).toBe(true)
    expect(store.getEmployeeDossier(silent.id).milestones.some((item) => item.title === '[group] 群聊协作')).toBe(false)
  })

  it('reuses a bounded query cache and invalidates it when milestone revision changes', async () => {
    const { store, workspace, world, employee } = await setup()
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '缓存私聊',
      participants: [{ participantId: employee.id, kind: 'employee' }],
    })
    const evidence = store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '偏好简洁回答', metadata: {} })
    store.appendEmployeeMilestone({ employeeId: employee.id, category: 'reflection', title: '[private] 私聊记忆', summary: '用户偏好简洁回答。', sourceMessageIds: [evidence.id], actorId: 'system' })
    let dossierReads = 0
    const memory = new EmployeeConversationMemoryService({
      getEmployee: store.getEmployee.bind(store),
      getEmployeeDossier: (employeeId) => { dossierReads += 1; return store.getEmployeeDossier(employeeId) },
      getEmployeeMilestoneRevision: store.getEmployeeMilestoneRevision.bind(store),
      getSession: store.getSession.bind(store),
      getWorkTurn: store.getWorkTurn.bind(store),
      listMessages: store.listMessages.bind(store),
      appendEmployeeMilestone: store.appendEmployeeMilestone.bind(store),
    })

    const first = await memory.compose({ employeeId: employee.id, conversationId: session.id, prompt: '我的回答偏好是什么？', budgetTokens: 256 })
    const second = await memory.compose({ employeeId: employee.id, conversationId: session.id, prompt: '我的回答偏好是什么？', budgetTokens: 256 })

    expect(second).toBe(first)
    expect(dossierReads).toBe(1)

    store.appendEmployeeMilestone({ employeeId: employee.id, category: 'reflection', title: '[private] 私聊记忆', summary: '用户新增偏好：重要结论先说。', sourceMessageIds: [evidence.id], actorId: 'system' })
    const refreshed = await memory.compose({ employeeId: employee.id, conversationId: session.id, prompt: '我的回答偏好是什么？', budgetTokens: 256 })

    expect(dossierReads).toBe(2)
    expect(refreshed).toContain('重要结论先说')
  })
})
