import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type {
  ConversationHistoryEntry,
  EmployeeBlueprint,
  EmployeeInstance,
  WorkSession,
} from '@dsh-cyber/contracts'
import { contextEnvelopeLayers } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { ConversationContextComposer } from '../src/services/conversation-context-composer.js'
import { EmployeeConversationMemoryService } from '../src/services/employee-conversation-memory-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'context.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责测试上下文编排',
    persona: '你只引用自己真实参与过的经历。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-composer-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '上下文世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'context.worker',
    blueprintVersion: 1,
  })
  const memory = new EmployeeConversationMemoryService(store)
  const composer = new ConversationContextComposer(store, memory)
  return { store, workspace, world, employee, memory, composer }
}

interface ExchangeInput {
  store: SqliteStore
  workspace: { id: string }
  world: { id: string }
  employee: EmployeeInstance
  session: WorkSession
  memory?: EmployeeConversationMemoryService
  ask: string
  answer: string
  interactionKind?: 'chat' | 'task' | 'meeting'
  runId: string
}

async function exchange(input: ExchangeInput): Promise<void> {
  const turn = input.store.createWorkTurn({
    workspaceId: input.workspace.id,
    worldId: input.world.id,
    sessionId: input.session.id,
    interactionKind: input.interactionKind ?? 'chat',
  })
  input.store.appendMessage({
    sessionId: input.session.id,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content: input.ask,
    metadata: { workTurnId: turn.id },
  })
  input.store.appendMessage({
    sessionId: input.session.id,
    senderId: input.employee.id,
    senderKind: 'employee',
    kind: 'assistant',
    content: input.answer,
    metadata: { workTurnId: turn.id, agentRunId: input.runId },
  })
  await input.memory?.rememberCompletedRun({
    employeeId: input.employee.id,
    sessionId: input.session.id,
    workTurnId: turn.id,
    agentRunId: input.runId,
  })
}

function history(store: SqliteStore, sessionId: string, employee: EmployeeInstance): ConversationHistoryEntry[] {
  return store
    .listMessages(sessionId)
    .filter((message) => message.kind === 'user' || message.kind === 'assistant')
    .map((message) => ({
      role: message.kind === 'user' ? 'user' as const : 'assistant' as const,
      sequence: message.sequence,
      speakerId: message.senderId,
      speakerName: message.senderKind === 'owner' ? '用户' : employee.displayName,
      content: message.content,
      createdAt: message.createdAt,
    }))
}

function allLayerText(result: { envelope: { stableIdentity: unknown } }): string {
  return contextEnvelopeLayers(result.envelope as never)
    .map((layer) => `${layer.text}\n${layer.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).join('\n')}`)
    .join('\n')
}

describe('ConversationContextComposer', () => {
  it('keeps the most recent turns raw and stops replaying the whole direct conversation every turn', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
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
    for (let index = 1; index <= 12; index += 1) {
      await exchange({
        store,
        workspace,
        world,
        employee,
        session,
        memory,
        ask: index === 1 ? '把老仓库的迁移方案记下来' : `第 ${index} 轮请求`,
        answer: index === 1 ? '老仓库迁移方案已记录：先冻结写入，再灰度切换。' : `第 ${index} 轮回答`,
        runId: `run-${index}`,
      })
    }
    const entries = history(store, session.id, employee)

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '老仓库迁移方案当时怎么定的？',
      history: entries,
      observedThroughSequence: 0,
    })

    expect(result.coverage.lane).toBe('direct')
    expect(result.recentHistory.length).toBeLessThan(entries.length)
    expect(result.coverage.droppedOlderEntryCount).toBeGreaterThan(0)
    expect(result.coverage.rawWindowApplied).toBe(true)
    expect(result.coverage.fullReplayFallback).toBe(false)
    // The raw window is a suffix of the durable history, never a reordering.
    expect(result.recentHistory).toEqual(entries.slice(entries.length - result.recentHistory.length))
    // The dropped opening turn is still reachable, through retrieval.
    expect(result.coverage.retrievedMemoryCount).toBeGreaterThan(0)
    expect(result.prompt).toContain('老仓库迁移方案')
    expect(result.prompt).toContain('[当前请求]')
    expect(result.envelope.retrievedMemories?.text).toContain('老仓库迁移方案')
    expect(result.envelope.memoryIndex).toBeDefined()
    expect(result.envelope.recentConversation?.text).toContain('第 12 轮回答')
  })

  it('never reaches a private memory from a group conversation', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const direct = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    await exchange({
      store,
      workspace,
      world,
      employee,
      session: direct,
      memory,
      ask: '金库密码是 7391，别对外说',
      answer: '明白，金库密码 7391 只在我们之间。',
      runId: 'run-private',
    })
    const group = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '群聊',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    await exchange({
      store,
      workspace,
      world,
      employee,
      session: group,
      memory,
      ask: '这周的排期是什么',
      answer: '这周先做迁移评审。',
      interactionKind: 'meeting',
      runId: 'run-group',
    })

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: group.id,
      // A deliberate probe: the group asks for exactly the private fact.
      prompt: '金库密码是多少？7391 对吗？',
      history: history(store, group.id, employee),
      observedThroughSequence: 0,
    })

    expect(result.coverage.lane).toBe('group')
    // The group lane is not on the bounded window yet; that is a choice, not a
    // fallback, and it must not be reported as one.
    expect(result.coverage.rawWindowApplied).toBe(false)
    expect(result.coverage.fullReplayFallback).toBe(false)
    expect(result.coverage.memoryScopes).toEqual(['group', 'task'])
    expect(result.prompt).not.toContain('金库密码是 7391')
    expect(allLayerText(result)).not.toContain('金库密码 7391')
    expect(result.envelope.retrievedMemories?.text ?? '').not.toContain('7391')
    const privateMilestone = store
      .getEmployeeDossier(employee.id)
      .milestones.find((milestone) => milestone.summary.includes('金库密码 7391'))
    expect(privateMilestone).toBeDefined()
    expect(allLayerText(result)).not.toContain(privateMilestone!.id)
  })

  it('never reaches a private memory from a routed task conversation', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const direct = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    await exchange({
      store,
      workspace,
      world,
      employee,
      session: direct,
      memory,
      ask: '我的私人邮箱是 secret-mailbox-42',
      answer: '记住了，secret-mailbox-42 不外传。',
      runId: 'run-private',
    })
    const task = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '任务：外发资料',
      collaborationMode: 'task',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    await exchange({
      store,
      workspace,
      world,
      employee,
      session: task,
      memory,
      ask: '整理外发资料',
      answer: '外发资料已整理完成。',
      interactionKind: 'task',
      runId: 'run-task',
    })

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: task.id,
      prompt: '把资料寄到 secret-mailbox-42 好吗？',
      history: history(store, task.id, employee),
      observedThroughSequence: 0,
    })

    expect(result.coverage.lane).toBe('task')
    expect(result.coverage.memoryScopes).toEqual(['group', 'task'])
    expect(allLayerText(result)).not.toContain('secret-mailbox-42 不外传')
  })

  it('keeps replaying the whole conversation when retrieval covers nothing', async () => {
    const { store, workspace, world, employee, composer } = await setup()
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
    // No memory service: nothing was ever remembered or indexed.
    for (let index = 1; index <= 12; index += 1) {
      await exchange({
        store,
        workspace,
        world,
        employee,
        session,
        ask: `第 ${index} 轮请求`,
        answer: `第 ${index} 轮回答`,
        runId: `run-${index}`,
      })
    }
    const entries = history(store, session.id, employee)

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '继续',
      history: entries,
      observedThroughSequence: 0,
    })

    expect(result.coverage.retrievedMemoryCount).toBe(0)
    expect(result.coverage.rawWindowApplied).toBe(false)
    expect(result.coverage.fullReplayFallback).toBe(true)
    expect(result.recentHistory).toEqual(entries)
  })

  it('never drops an entry the live runtime session has not observed', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
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
    for (let index = 1; index <= 12; index += 1) {
      await exchange({
        store,
        workspace,
        world,
        employee,
        session,
        memory,
        ask: `第 ${index} 轮请求`,
        answer: `第 ${index} 轮回答`,
        runId: `run-${index}`,
      })
    }
    const entries = history(store, session.id, employee)

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '继续',
      history: entries,
      observedThroughSequence: 2,
    })

    expect(result.recentHistory[0]!.sequence).toBe(3)
    expect(result.recentHistory).toEqual(entries.filter((entry) => entry.sequence > 2))
  })

  it('gives a routed task its own context layer instead of burying the plan in a chat summary', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '任务：站点分析',
      collaborationMode: 'task',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'task',
    })
    const plan = store.createTaskCollaborationPlan({
      taskId: 'task-site-analysis',
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      workTurnId: turn.id,
      steps: [
        { id: 'search', requiredSkills: ['web.search'], assignedEmployeeIds: [employee.id], dependsOn: [], executionMode: 'parallel', status: 'completed' },
        { id: 'build', requiredSkills: ['frontend.build'], assignedEmployeeIds: [employee.id], dependsOn: ['search'], executionMode: 'sequential', status: 'running' },
      ],
    })
    await exchange({
      store,
      workspace,
      world,
      employee,
      session,
      memory,
      ask: '开始站点分析',
      answer: '已完成检索步骤。',
      interactionKind: 'task',
      runId: 'run-task-1',
    })

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '现在做什么？',
      history: history(store, session.id, employee),
      observedThroughSequence: 0,
    })

    const taskContext = result.envelope.taskContext
    expect(taskContext).toBeDefined()
    expect(taskContext!.kind).toBe('task-context')
    expect(taskContext!.text).toContain('任务：站点分析')
    expect(taskContext!.text).toContain('search')
    expect(taskContext!.text).toContain('build')
    expect(taskContext!.text).toContain('web.search')
    // Dependencies and completed steps are explicit, not prose.
    expect(taskContext!.text).toContain('依赖：search')
    expect(taskContext!.text).toContain('已完成步骤：search')
    expect(taskContext!.sourceRefs.some((ref) => ref.kind === 'session' && ref.id === session.id)).toBe(true)
    expect(taskContext!.sourceRefs.some((ref) => ref.kind === 'work-turn' && ref.id === plan.workTurnId)).toBe(true)
    expect(result.prompt).toContain('[任务上下文]')
  })

  it('survives a runtime prompt that is far longer than the retrieval index accepts', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
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
    await exchange({ store, workspace, world, employee, session, memory, ask: '记一下迁移方案', answer: '迁移方案已记录。', runId: 'run-1' })

    // A Skill continuation prompt carries a whole action report; the index
    // rejects a query this long, so the composer must bound it, not crash.
    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: `${'世界管理动作执行报告：已重命名世界。'.repeat(80)}\n\n[当前请求]\n继续`,
      history: history(store, session.id, employee),
      observedThroughSequence: 0,
    })

    expect(result.coverage.retrievedMemoryCount).toBeGreaterThan(0)
    expect(result.prompt).toContain('[当前请求]')
  })

  it('keeps two concurrent conversations of one employee independent', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const first = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊一',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const second = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '群聊二',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    await exchange({ store, workspace, world, employee, session: first, memory, ask: '私聊问题', answer: '私聊回答 alpha-only', runId: 'run-a' })
    await exchange({ store, workspace, world, employee, session: second, memory, ask: '群聊问题', answer: '群聊回答 beta-only', interactionKind: 'meeting', runId: 'run-b' })

    const [directResult, groupResult] = await Promise.all([
      composer.compose({
        employee,
        persona: '你只引用自己真实参与过的经历。',
        conversationId: first.id,
        prompt: '继续私聊',
        history: history(store, first.id, employee),
        observedThroughSequence: 0,
      }),
      composer.compose({
        employee,
        persona: '你只引用自己真实参与过的经历。',
        conversationId: second.id,
        prompt: '继续群聊',
        history: history(store, second.id, employee),
        observedThroughSequence: 0,
      }),
    ])

    expect(directResult.coverage.lane).toBe('direct')
    expect(groupResult.coverage.lane).toBe('group')
    // The cacheable identity prefix is the same character in both lanes.
    expect(directResult.envelope.stableContextHash).toBe(groupResult.envelope.stableContextHash)
    expect(directResult.envelope.recentConversation?.text).toContain('私聊回答 alpha-only')
    expect(directResult.envelope.recentConversation?.text ?? '').not.toContain('beta-only')
    expect(groupResult.envelope.recentConversation?.text).toContain('群聊回答 beta-only')
    expect(groupResult.envelope.recentConversation?.text ?? '').not.toContain('alpha-only')
    expect(allLayerText(groupResult)).not.toContain('alpha-only')
  })
})
