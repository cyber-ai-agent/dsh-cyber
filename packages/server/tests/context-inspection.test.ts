import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentRuntimePort,
  AgentTurnRequest,
  ConversationHistoryEntry,
  EmployeeBlueprint,
  EmployeeInstance,
  WorkSession,
} from '@dsh-cyber/contracts'
import { CONTEXT_LAYER_ORDER } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'
import { ConversationContextComposer } from '../src/services/conversation-context-composer.js'
import { ContextInspectionService } from '../src/services/context-inspection-service.js'
import { EmployeeConversationMemoryService } from '../src/services/employee-conversation-memory-service.js'

/**
 * The Context Inspector describes the context this product built and sent.
 *
 * Two of these tests are boundaries rather than features: a credential that
 * reached the composed context must not reach the Inspector, and a private
 * memory must stay unreachable from a group conversation even in a read-only
 * observation surface. An inspector is a new way to read the context, so every
 * rule the context itself obeys has to survive being looked at.
 */

class CaptureRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return { agentSessionId: 'agent-session', finalResponse: '好的。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'inspector.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责测试上下文检查器',
    persona: '你只引用自己真实参与过的经历。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-inspection-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '上下文世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'inspector.worker',
    blueprintVersion: 1,
  })
  const memory = new EmployeeConversationMemoryService(store)
  const composer = new ConversationContextComposer(store, memory)
  const inspection = new ContextInspectionService()
  return { store, workspace, world, employee, memory, composer, inspection }
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
  runId: string
}

async function exchange(input: ExchangeInput): Promise<void> {
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

describe('ContextInspectionService', () => {
  it('describes every layer the turn was actually given', async () => {
    const { store, workspace, world, employee, memory, composer, inspection } = await setup()
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

    const composed = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '老仓库迁移方案当时怎么定的？',
      history: history(store, session.id, employee),
      observedThroughSequence: 0,
    })
    inspection.record({
      conversationId: session.id,
      employeeId: employee.id,
      employeeName: employee.displayName,
      lane: composed.coverage.lane,
      envelope: composed.envelope,
      memoryHits: composed.memoryHits,
      coverage: composed.coverage,
      budget: {
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
        safetyMarginTokens: 1_638,
        inputBudgetTokens: 27_034,
        fixedTokens: 40,
        workingTokens: 4_318,
        historyTokens: 14_037,
        memoryTokens: 3_779,
        knowledgeTokens: 4_860,
      },
    })

    const view = inspection.latest(session.id)
    expect(view).toBeDefined()
    expect(view!.lane).toBe('direct')
    expect(view!.employeeName).toBe('小林')
    expect(view!.usedTokens).toBe(composed.envelope.totalTokenEstimate)
    expect(view!.budget.contextWindow).toBe(32_768)
    expect(view!.budget.memoryTokens).toBe(3_779)

    // Layers arrive in cache-prefix order, and every one of them is described.
    const kinds = view!.layers.map((layer) => layer.kind)
    expect(kinds).toEqual([...CONTEXT_LAYER_ORDER].filter((kind) => kinds.includes(kind)))
    expect(kinds).toContain('stable-identity')
    expect(kinds).toContain('memory-index')
    expect(kinds).toContain('retrieved-memories')
    expect(kinds).toContain('recent-conversation')
    expect(kinds).toContain('current-request')
    for (const layer of view!.layers) {
      expect(layer.tokenEstimate).toBeGreaterThan(0)
      expect(layer.revision).not.toBe('')
      expect(layer.contentHash).toMatch(/^[0-9a-f]{32}$/)
      expect(layer.sourceCount).toBeGreaterThanOrEqual(0)
    }
    // The user's own request and their own recent messages are theirs to read.
    const request = view!.layers.find((layer) => layer.kind === 'current-request')
    expect(request?.preview).toContain('老仓库迁移方案')
    expect(view!.coverage.droppedOlderEntryCount).toBeGreaterThan(0)
    expect(view!.coverage.rawWindowApplied).toBe(true)
  })

  it('explains each memory hit by id, score and reason', async () => {
    const { store, workspace, world, employee, memory, composer, inspection } = await setup()
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

    const composed = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '老仓库迁移方案当时怎么定的？',
      history: history(store, session.id, employee),
      observedThroughSequence: 0,
    })
    expect(composed.memoryHits.length).toBeGreaterThan(0)
    inspection.record({
      conversationId: session.id,
      employeeId: employee.id,
      employeeName: employee.displayName,
      lane: composed.coverage.lane,
      envelope: composed.envelope,
      memoryHits: composed.memoryHits,
      coverage: composed.coverage,
    })

    const hits = inspection.latest(session.id)!.memoryHits
    expect(hits.length).toBe(composed.memoryHits.length)
    const [first] = hits
    expect(first!.memoryId).toBe(composed.memoryHits[0]!.entry.memoryId)
    // The memory id is the durable milestone id, so the hit stays relocatable.
    const milestones = store.getEmployeeDossier(employee.id).milestones
    expect(milestones.some((milestone) => milestone.id === first!.memoryId)).toBe(true)
    expect(first!.scope).toBe('private')
    expect(first!.score).toBeGreaterThan(0)
    expect(first!.reason).toContain('记忆重要度')
    expect(first!.sourceMessageCount).toBeGreaterThan(0)
    expect(first!.summary.length).toBeGreaterThan(0)
  })

  it('never lets a credential reach the inspector', async () => {
    const { store, workspace, world, employee, memory, composer, inspection } = await setup()
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
    const apiKey = 'sk-live-9f2a7c41d8e6b305a7c2'
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaa.bbbbbbbbbbbb'
    const envSecret = 'DEEPSEEK_API_KEY=abcdefghijklmnop'
    await exchange({
      store,
      workspace,
      world,
      employee,
      session,
      memory,
      ask: `帮我调这个接口，密钥 ${apiKey}，请求头 Authorization: ${bearer}`,
      answer: `已经用 ${apiKey} 调通了，环境变量写成 ${envSecret}。`,
      runId: 'run-secret',
    })

    const composed = await composer.compose({
      employee,
      // A credential can arrive through the persona too, not only through chat.
      persona: `你只引用自己真实参与过的经历。\n运行凭据：${apiKey}`,
      conversationId: session.id,
      prompt: `继续用 ${apiKey} 调用，Authorization: ${bearer}`,
      history: history(store, session.id, employee),
      observedThroughSequence: 0,
    })
    // The composed context genuinely carries the secret; this is what the
    // Inspector must refuse to hand back.
    expect(composed.envelope.currentRequest.text).toContain(apiKey)

    inspection.record({
      conversationId: session.id,
      employeeId: employee.id,
      employeeName: employee.displayName,
      lane: composed.coverage.lane,
      envelope: composed.envelope,
      memoryHits: composed.memoryHits,
      coverage: composed.coverage,
    })

    const serialized = JSON.stringify(inspection.latest(session.id))
    expect(serialized).not.toContain(apiKey)
    expect(serialized).not.toContain('sk-live-')
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(serialized).not.toContain('abcdefghijklmnop')
    expect(serialized).toContain('已隐藏敏感信息')
    // Redaction must not swallow the layer: the user still sees what was sent.
    const request = inspection.latest(session.id)!.layers.find((layer) => layer.kind === 'current-request')
    expect(request?.preview).toContain('继续用')
  })

  it('never surfaces a private memory through a group conversation', async () => {
    const { store, workspace, world, employee, memory, composer, inspection } = await setup()
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
      runId: 'run-group',
    })

    const composed = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: group.id,
      prompt: '金库密码是多少？7391 对吗？',
      history: history(store, group.id, employee),
      observedThroughSequence: 0,
    })
    inspection.record({
      conversationId: group.id,
      employeeId: employee.id,
      employeeName: employee.displayName,
      lane: composed.coverage.lane,
      envelope: composed.envelope,
      memoryHits: composed.memoryHits,
      coverage: composed.coverage,
    })

    const view = inspection.latest(group.id)!
    expect(view.lane).toBe('group')
    expect(view.coverage.memoryScopes).toEqual(['group', 'task'])
    expect(view.memoryHits.every((hit) => hit.scope !== 'private')).toBe(true)
    const privateMilestone = store
      .getEmployeeDossier(employee.id)
      .milestones.find((milestone) => milestone.summary.includes('金库密码 7391'))
    expect(privateMilestone).toBeDefined()
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(privateMilestone!.id)
    expect(serialized).not.toContain('金库密码 7391')
  })

  it('reports no cache data instead of inventing a hit rate', async () => {
    const { store, workspace, world, employee, composer, inspection } = await setup()
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
    const composed = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: session.id,
      prompt: '开始吧',
      history: [],
      observedThroughSequence: 0,
    })

    inspection.record({
      conversationId: session.id,
      employeeId: employee.id,
      employeeName: employee.displayName,
      lane: composed.coverage.lane,
      envelope: composed.envelope,
      memoryHits: composed.memoryHits,
      coverage: composed.coverage,
    })
    const withoutCache = inspection.latest(session.id)!.cache
    expect(withoutCache.state).toBe('unavailable')
    expect(withoutCache.cachedTokens).toBeUndefined()
    expect(withoutCache.uncachedTokens).toBeUndefined()
    // The prefix identity is ours, not the provider's, so it is always shown.
    expect(withoutCache.stableContextHash).toBe(composed.envelope.stableContextHash)

    // The seam a prompt-cache runtime fills in later.
    inspection.record({
      conversationId: session.id,
      employeeId: employee.id,
      employeeName: employee.displayName,
      lane: composed.coverage.lane,
      envelope: composed.envelope,
      memoryHits: composed.memoryHits,
      coverage: composed.coverage,
      cache: { state: 'hit', cachedTokens: 900, uncachedTokens: 120 },
    })
    const withCache = inspection.latest(session.id)!.cache
    expect(withCache.state).toBe('hit')
    expect(withCache.cachedTokens).toBe(900)
    expect(withCache.uncachedTokens).toBe(120)
  })

  it('records the context a real turn ran with, not a rebuilt guess', async () => {
    const { store, workspace, world, employee } = await setup()
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
    const inner = new CaptureRuntime()
    const runtime = new CharacterProfileRuntime(inner, store)

    await runtime.runTurn({
      agent: employee,
      revision: store.getEmployeeRevision(employee.id, employee.currentRevision)!,
      conversationId: session.id,
      history: [],
      observedThroughSequence: 0,
      prompt: '今天先做什么？',
      workspacePath: '/tmp/world',
      permissionMode: 'workspace-write',
    })

    const view = runtime.contextInspection.latest(session.id)
    expect(view).toBeDefined()
    expect(view!.employeeId).toBe(employee.id)
    expect(view!.lane).toBe('direct')
    const identity = view!.layers.find((layer) => layer.kind === 'stable-identity')
    // The permission mode is a property of the request, not of any durable row.
    // Seeing it here is the proof that this is a record of the real turn rather
    // than a re-derivation that could only have guessed at it.
    expect(identity?.preview).toContain('workspace-write')
    expect(view!.layers.find((layer) => layer.kind === 'current-request')?.preview).toContain('今天先做什么')
  })

  it('answers nothing for a conversation that has not run a turn', async () => {
    const { inspection } = await setup()
    expect(inspection.latest('session-never-run')).toBeUndefined()
  })

  it('drops the least recently recorded conversation instead of growing forever', async () => {
    const { store, workspace, world, employee, composer } = await setup()
    const bounded = new ContextInspectionService({ maxConversations: 2 })
    const ids: string[] = []
    for (const title of ['一', '二', '三']) {
      const session = store.createSession({
        workspaceId: workspace.id,
        worldId: world.id,
        kind: 'direct',
        title,
        participants: [
          { participantId: 'owner', kind: 'owner' },
          { participantId: employee.id, kind: 'employee' },
        ],
      })
      ids.push(session.id)
      const composed = await composer.compose({
        employee,
        persona: '你只引用自己真实参与过的经历。',
        conversationId: session.id,
        prompt: `第 ${title} 个会话`,
        history: [],
        observedThroughSequence: 0,
      })
      bounded.record({
        conversationId: session.id,
        employeeId: employee.id,
        employeeName: employee.displayName,
        lane: composed.coverage.lane,
        envelope: composed.envelope,
        memoryHits: composed.memoryHits,
        coverage: composed.coverage,
      })
    }
    expect(bounded.latest(ids[0]!)).toBeUndefined()
    expect(bounded.latest(ids[1]!)).toBeDefined()
    expect(bounded.latest(ids[2]!)).toBeDefined()
  })
})
