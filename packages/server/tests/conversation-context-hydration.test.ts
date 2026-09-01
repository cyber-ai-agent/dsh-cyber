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
import { contextEnvelopeLayers, estimateTextTokens } from '@dsh-cyber/contracts'
import { SqliteStore, memoryIndexTerms } from '@dsh-cyber/persistence'

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
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-hydration-'))
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

/**
 * A turn that never produced a completed AgentRun: the owner spoke, the run
 * failed or was aborted, and nothing was ever remembered for it.
 */
function interruptedTurn(input: {
  store: SqliteStore
  workspace: { id: string }
  world: { id: string }
  session: WorkSession
  ask: string
}): void {
  const turn = input.store.createWorkTurn({
    workspaceId: input.workspace.id,
    worldId: input.world.id,
    sessionId: input.session.id,
    interactionKind: 'chat',
  })
  input.store.appendMessage({
    sessionId: input.session.id,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content: input.ask,
    metadata: { workTurnId: turn.id },
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

function directSession(
  store: SqliteStore,
  workspace: { id: string },
  world: { id: string },
  employee: EmployeeInstance,
): WorkSession {
  return store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: '私聊',
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
    ],
  })
}

/** A long answer whose tail survives only in the raw message, never in the rendered summary. */
function longAnswer(marker: string): string {
  return `迁移方案要点：${'先冻结写入再灰度切换。'.repeat(70)}最终校验指纹 ${marker}。`
}

describe('retrieved memory hydration', () => {
  it('brings back the raw source messages of a retrieved memory, not only its rendered summary', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const session = directSession(store, workspace, world, employee)
    await exchange({
      store,
      workspace,
      world,
      employee,
      session,
      memory,
      ask: '把老仓库的迁移方案记下来',
      answer: longAnswer('ZX-9911'),
      runId: 'run-1',
    })
    for (let index = 2; index <= 12; index += 1) {
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
    const sourceMessages = store.listMessages(session.id).slice(0, 2)

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '老仓库迁移方案当时怎么定的？最终校验指纹是什么？',
      history: entries,
      observedThroughSequence: 0,
      memoryBudgetTokens: 4_000,
    })

    // The turn is out of the raw window: only retrieval can answer it now.
    expect(result.coverage.rawWindowApplied).toBe(true)
    expect(result.recentHistory.some((entry) => entry.content.includes('ZX-9911'))).toBe(false)
    // The rendered summary truncates before the fingerprint; hydration is the
    // only thing that can put the actual source message back in front of the model.
    expect(result.coverage.hydratedMemoryCount).toBeGreaterThan(0)
    expect(result.coverage.hydratedSourceMessageCount).toBeGreaterThan(0)
    expect(result.envelope.retrievedMemories?.text ?? '').toContain('ZX-9911')
    expect(result.prompt).toContain('ZX-9911')
    // A hydrated memory keeps pointers to the rows it was hydrated from.
    const refs = result.envelope.retrievedMemories?.sourceRefs ?? []
    for (const message of sourceMessages) {
      expect(refs.some((ref) => ref.kind === 'message' && ref.id === message.id)).toBe(true)
    }
  })

  it('keeps the whole memory block inside the memory budget when it hydrates', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const session = directSession(store, workspace, world, employee)
    await exchange({
      store,
      workspace,
      world,
      employee,
      session,
      memory,
      ask: '把老仓库的迁移方案记下来',
      answer: longAnswer('ZX-9911'),
      runId: 'run-1',
    })
    for (let index = 2; index <= 12; index += 1) {
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

    const tight = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '老仓库迁移方案当时怎么定的？',
      history: entries,
      observedThroughSequence: 0,
      memoryBudgetTokens: 600,
    })

    const memoryTokens = (tight.envelope.memoryIndex?.tokenEstimate ?? 0)
      + (tight.envelope.retrievedMemories?.tokenEstimate ?? 0)
    expect(memoryTokens).toBeLessThanOrEqual(600)
    expect(estimateTextTokens(tight.envelope.retrievedMemories?.text ?? '')).toBeLessThanOrEqual(600)
  })

  /**
   * A private episode that is genuinely out of its own raw window, so hydration
   * is the mechanism that would put it back. The direct lane is the control: it
   * proves hydration really does reach this memory, which is what makes the
   * group lane's refusal mean something.
   */
  async function vaultSetup() {
    const context = await setup()
    const { store, workspace, world, employee, memory } = context
    const direct = directSession(store, workspace, world, employee)
    await exchange({
      store,
      workspace,
      world,
      employee,
      session: direct,
      memory,
      ask: '记下金库处置方案',
      answer: longAnswer('金库密码 7391'),
      runId: 'run-private',
    })
    for (let index = 2; index <= 12; index += 1) {
      await exchange({
        store,
        workspace,
        world,
        employee,
        session: direct,
        memory,
        ask: `第 ${index} 轮请求`,
        answer: `第 ${index} 轮回答`,
        runId: `run-${index}`,
      })
    }
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
    const privateMilestone = store
      .getEmployeeDossier(employee.id)
      .milestones.find((milestone) => milestone.summary.includes('金库处置方案'))
    expect(privateMilestone).toBeDefined()
    return { ...context, direct, group, privateMilestone: privateMilestone! }
  }

  const vaultPrompt = '金库处置方案的最终校验指纹是什么？'

  it('never hydrates a private raw message into a group conversation', async () => {
    const { store, employee, composer, direct, group } = await vaultSetup()

    // Control: in the character's own private chat the episode is out of the
    // raw window and hydration is exactly what brings the secret back.
    const own = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: direct.id,
      prompt: vaultPrompt,
      history: history(store, direct.id, employee),
      observedThroughSequence: 0,
      memoryBudgetTokens: 4_000,
    })
    expect(own.coverage.hydratedSourceMessageCount).toBeGreaterThan(0)
    expect(own.envelope.retrievedMemories?.text ?? '').toContain('7391')

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: group.id,
      prompt: vaultPrompt,
      history: history(store, group.id, employee),
      observedThroughSequence: 0,
      memoryBudgetTokens: 4_000,
    })

    expect(result.coverage.memoryScopes).toEqual(['group', 'task'])
    expect(allLayerText(result)).not.toContain('7391')
    const privateMessageIds = new Set(store.listMessages(direct.id).map((message) => message.id))
    const refs = result.envelope.retrievedMemories?.sourceRefs ?? []
    expect(refs.some((ref) => ref.kind === 'message' && privateMessageIds.has(ref.id))).toBe(false)
  })

  it('refuses to hydrate a private raw message even when the index row claims a group scope', async () => {
    const { store, employee, composer, group, privateMilestone } = await vaultSetup()
    // Deliberate corruption of the derived index: the scope column now lies.
    // The raw-message boundary must be re-derived from the message's own
    // session, so a mis-scoped index row still cannot replay private text.
    store.indexEmployeeMemory({
      memoryId: privateMilestone.id,
      scope: 'group',
      keywords: memoryIndexTerms(privateMilestone.summary),
      entities: [],
      importance: 0.9,
    })

    const result = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: group.id,
      prompt: vaultPrompt,
      history: history(store, group.id, employee),
      observedThroughSequence: 0,
      memoryBudgetTokens: 4_000,
    })

    // The mis-scoped index row does surface its own summary and its own source
    // refs - that is the index row's trust boundary, and this slice does not
    // change it. The raw message tail beyond the 700-character summary
    // rendering is what hydration would newly add, and hydration re-derives the
    // boundary from the message's own session, so it must refuse.
    const memoryIds = (result.envelope.memoryIndex?.sourceRefs ?? []).map((ref) => ref.id)
    expect(memoryIds).toContain(privateMilestone.id)
    expect(allLayerText(result)).not.toContain('7391')
    const hydrated = (result.envelope.retrievedMemories?.text ?? '').split('[记忆原文]')[1] ?? ''
    expect(hydrated).not.toContain(privateMilestone.id)
    expect(hydrated).not.toContain('迁移方案要点')
  })
})

describe('turns that were never remembered', () => {
  it('never drops a turn that produced no completed AgentRun', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const session = directSession(store, workspace, world, employee)
    await exchange({
      store,
      workspace,
      world,
      employee,
      session,
      memory,
      ask: '第 1 轮请求',
      answer: '第 1 轮回答',
      runId: 'run-1',
    })
    await exchange({
      store,
      workspace,
      world,
      employee,
      session,
      memory,
      ask: '第 2 轮请求',
      answer: '第 2 轮回答',
      runId: 'run-2',
    })
    // The owner asked; the run failed and nothing was ever remembered for it.
    interruptedTurn({ store, workspace, world, session, ask: '中断轮请求 QQ-4242 别忘了' })
    for (let index = 4; index <= 14; index += 1) {
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
      observedThroughSequence: 0,
    })

    // It was never indexed, so retrieval can never bring it back. Full replay
    // would have shown it, therefore the window must not drop it.
    expect(result.recentHistory.some((entry) => entry.content.includes('QQ-4242'))).toBe(true)
    expect(result.coverage.unrememberedRawEntryCount).toBeGreaterThan(0)
    // Still bounded: the remembered turns before it are still dropped.
    expect(result.coverage.droppedOlderEntryCount).toBeGreaterThan(0)
    expect(result.recentHistory.length).toBeLessThan(entries.length)
    expect(result.recentHistory).toEqual(entries.slice(entries.length - result.recentHistory.length))
  })

  it('reports no unremembered entries when every dropped turn is indexed', async () => {
    const { store, workspace, world, employee, memory, composer } = await setup()
    const session = directSession(store, workspace, world, employee)
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
      observedThroughSequence: 0,
    })

    expect(result.coverage.unrememberedRawEntryCount).toBe(0)
    expect(result.coverage.droppedOlderEntryCount).toBeGreaterThan(0)
  })
})
