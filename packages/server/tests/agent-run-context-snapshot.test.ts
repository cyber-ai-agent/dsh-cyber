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
import { composeContextSnapshot } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { ConversationContextComposer } from '../src/services/conversation-context-composer.js'
import { ContextSnapshotService } from '../src/services/context-snapshot-service.js'
import { EmployeeConversationMemoryService } from '../src/services/employee-conversation-memory-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'snapshot.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责测试上下文快照',
    persona: '你只引用自己真实参与过的经历。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-snapshot-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '快照世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'snapshot.worker',
    blueprintVersion: 1,
  })
  const memory = new EmployeeConversationMemoryService(store)
  const composer = new ConversationContextComposer(store, memory)
  const snapshots = new ContextSnapshotService(store)
  return { store, workspace, world, employee, memory, composer, snapshots }
}

function session(
  store: SqliteStore,
  workspace: { id: string },
  world: { id: string },
  employee: EmployeeInstance,
  kind: 'direct' | 'group',
): WorkSession {
  return store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind,
    title: kind === 'direct' ? '私聊' : '群聊',
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
    ],
  })
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

/** One complete owner→character exchange, remembered as a durable milestone. */
async function exchange(input: ExchangeInput): Promise<{ turnId: string; agentRunId: string }> {
  const turn = input.store.createWorkTurn({
    workspaceId: input.workspace.id,
    worldId: input.world.id,
    sessionId: input.session.id,
    interactionKind: 'chat',
  })
  const run = input.store.createAgentRun({
    workspaceId: input.workspace.id,
    worldId: input.world.id,
    turnId: turn.id,
    sessionId: input.session.id,
    employeeId: input.employee.id,
    ordinal: 1,
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
    metadata: { workTurnId: turn.id, agentRunId: run.id },
  })
  await input.memory?.rememberCompletedRun({
    employeeId: input.employee.id,
    sessionId: input.session.id,
    workTurnId: turn.id,
    agentRunId: run.id,
  })
  return { turnId: turn.id, agentRunId: run.id }
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

/** The raw stored row, read straight from SQLite with no service in between. */
function storedRow(store: SqliteStore, agentRunId: string): Record<string, unknown> {
  return store.database
    .prepare('SELECT * FROM agent_run_context_snapshots WHERE agent_run_id = ?')
    .get(agentRunId) as Record<string, unknown>
}

describe('agent run context snapshot', () => {
  it('round-trips a run to a safe reconstructed view built from the durable rows', async () => {
    const { store, workspace, world, employee, memory, composer, snapshots } = await setup()
    const direct = session(store, workspace, world, employee, 'direct')
    await exchange({
      store, workspace, world, employee, session: direct, memory,
      ask: '把老仓库的迁移方案记下来',
      answer: `迁移方案要点：${'先冻结写入再灰度切换。'.repeat(40)}最终校验指纹 ZX-9911。`,
      runId: 'seed',
    })
    for (let index = 2; index <= 10; index += 1) {
      await exchange({
        store, workspace, world, employee, session: direct, memory,
        ask: `第 ${index} 轮请求`,
        answer: `第 ${index} 轮回答`,
        runId: `run-${index}`,
      })
    }

    const turn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: direct.id, interactionKind: 'chat',
    })
    const run = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: turn.id,
      sessionId: direct.id, employeeId: employee.id, ordinal: 1,
    })
    const composed = await composer.compose({
      employee,
      persona: '你只引用自己真实参与过的经历。',
      conversationId: direct.id,
      prompt: '当时的迁移校验指纹是多少？',
      history: history(store, direct.id, employee),
      observedThroughSequence: 0,
      workTurnId: turn.id,
    })

    const saved = snapshots.save({ agentRunId: run.id, envelope: composed.envelope })
    expect(saved?.stablePrefixHash).toBe(composed.envelope.stableContextHash)
    expect(saved?.totalTokenEstimate).toBe(composed.envelope.totalTokenEstimate)

    const view = snapshots.reconstruct(run.id)
    expect(view).toBeDefined()
    expect(view!.visibleScopes).toEqual(['private', 'group', 'task'])
    expect(view!.refusedRefCount).toBe(0)
    // Every layer of the envelope survives as structure.
    expect(view!.layers.map((layer) => layer.kind)).toEqual(
      composed.envelope.stableIdentity === undefined ? [] : [
        'stable-identity',
        ...(composed.envelope.taskContext === undefined ? [] : ['task-context']),
        ...(composed.envelope.memoryIndex === undefined ? [] : ['memory-index']),
        ...(composed.envelope.retrievedMemories === undefined ? [] : ['retrieved-memories']),
        ...(composed.envelope.recentConversation === undefined ? [] : ['recent-conversation']),
        'current-request',
      ],
    )

    // The content comes back through the pointers, not out of the snapshot.
    const retrieved = view!.layers.find((layer) => layer.kind === 'retrieved-memories')
    expect(retrieved?.memories.length).toBeGreaterThan(0)
    expect(retrieved!.messages.map((message) => message.content).join('\n')).toContain('ZX-9911')
    // Rows that were relocated are the originals, not copies stored by D4.
    for (const message of retrieved!.messages) {
      expect(store.getMessages([message.id])[0]?.content).toBe(message.content)
    }
  })

  it('stores no prompt text — asserted on the stored row, not on an API', async () => {
    const { store, workspace, world, employee, memory, composer, snapshots } = await setup()
    const direct = session(store, workspace, world, employee, 'direct')
    const secret = '离职补偿谈判底线是三个月工资 QW-4477'
    await exchange({
      store, workspace, world, employee, session: direct, memory,
      ask: '记住这件事',
      answer: secret,
      runId: 'seed',
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: direct.id, interactionKind: 'chat',
    })
    const run = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: turn.id,
      sessionId: direct.id, employeeId: employee.id, ordinal: 1,
    })
    const prompt = '谈判底线还记得吗 PROMPT-MARKER-8823'
    const composed = await composer.compose({
      employee,
      persona: '你是一位人事顾问 PERSONA-MARKER-1122。',
      conversationId: direct.id,
      prompt,
      history: history(store, direct.id, employee),
      observedThroughSequence: 0,
      workTurnId: turn.id,
    })
    snapshots.save({ agentRunId: run.id, envelope: composed.envelope })

    const row = storedRow(store, run.id)
    const serialized = Object.values(row).map((value) => String(value)).join('\n')
    // Nothing that was rendered into the prompt may appear anywhere in the row.
    expect(serialized).not.toContain('PROMPT-MARKER-8823')
    expect(serialized).not.toContain('PERSONA-MARKER-1122')
    expect(serialized).not.toContain('QW-4477')
    expect(serialized).not.toContain('谈判底线')
    // And no layer object carries a text field at all.
    for (const layer of JSON.parse(String(row.layers_json)) as Record<string, unknown>[]) {
      expect(Object.keys(layer).sort()).toEqual(
        ['contentHash', 'id', 'kind', 'revision', 'sourceRefs', 'tokenEstimate'],
      )
    }
    // The structure it does keep is real: hashes and token counts survive.
    expect(String(row.stable_prefix_hash)).toBe(composed.envelope.stableContextHash)
    expect(Number(row.total_token_estimate)).toBeGreaterThan(0)
  })

  it('refuses a cross-scope read: a group run cannot reconstruct a private message', async () => {
    const { store, workspace, world, employee, memory, snapshots } = await setup()
    const direct = session(store, workspace, world, employee, 'direct')
    const group = session(store, workspace, world, employee, 'group')

    await exchange({
      store, workspace, world, employee, session: direct, memory,
      ask: '这件事只在私聊里说',
      answer: '收到，仅私聊留存 PRIVATE-ONLY-5150。',
      runId: 'private',
    })
    const privateMessages = store.listMessages(direct.id)
    const privateMemory = store.listEmployeeMemoryIndex(employee.id, ['private'], 10)[0]
    expect(privateMemory).toBeDefined()

    const groupTurn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: group.id, interactionKind: 'chat',
    })
    const groupRun = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: groupTurn.id,
      sessionId: group.id, employeeId: employee.id, ordinal: 1,
    })

    // A snapshot that points at private rows from a group run. The composer
    // would never build this; the reconstruction path must refuse it anyway,
    // because a snapshot is derived data and must not be the only check.
    store.saveAgentRunContextSnapshot({
      agentRunId: groupRun.id,
      snapshot: {
        snapshotVersion: 1,
        envelopeVersion: 1,
        stablePrefixHash: 'deadbeef',
        structureHash: 'cafebabe',
        totalTokenEstimate: 42,
        layers: [{
          id: `retrieved-memories:${employee.id}`,
          kind: 'retrieved-memories',
          revision: 'r1',
          contentHash: 'c1',
          tokenEstimate: 42,
          sourceRefs: [
            { kind: 'memory', id: privateMemory!.memoryId },
            ...privateMessages.map((message) => ({ kind: 'message' as const, id: message.id })),
          ],
        }],
        cache: { stablePrefixTokens: 0, volatileTokens: 42, prefixReused: false },
      },
    })

    const view = snapshots.reconstruct(groupRun.id)
    expect(view).toBeDefined()
    expect(view!.visibleScopes).toEqual(['group', 'task'])
    const layer = view!.layers[0]!
    expect(layer.messages).toEqual([])
    expect(layer.memories).toEqual([])
    expect(layer.refusedRefs.length).toBe(1 + privateMessages.length)
    expect(view!.refusedRefCount).toBe(1 + privateMessages.length)
    expect(JSON.stringify(view)).not.toContain('PRIVATE-ONLY-5150')

    // The same pointers are readable from the conversation they belong to, so
    // the refusal is the scope rule and not a broken lookup.
    const directTurn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: direct.id, interactionKind: 'chat',
    })
    const directRun = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: directTurn.id,
      sessionId: direct.id, employeeId: employee.id, ordinal: 1,
    })
    const stored = store.getAgentRunContextSnapshot(groupRun.id)!
    store.saveAgentRunContextSnapshot({ agentRunId: directRun.id, snapshot: stored })
    const directView = snapshots.reconstruct(directRun.id)!
    expect(directView.refusedRefCount).toBe(0)
    expect(directView.layers[0]!.memories.map((entry) => entry.memoryId)).toEqual([privateMemory!.memoryId])
    expect(directView.layers[0]!.messages.map((message) => message.content).join('\n'))
      .toContain('PRIVATE-ONLY-5150')
  })

  it('reports prefix-cache reuse across consecutive runs of the same conversation', async () => {
    const { store, workspace, world, employee, snapshots } = await setup()
    const direct = session(store, workspace, world, employee, 'direct')
    const composer = new ConversationContextComposer(store, undefined)

    const composeFor = async (persona: string, prompt: string) => {
      const turn = store.createWorkTurn({
        workspaceId: workspace.id, worldId: world.id, sessionId: direct.id, interactionKind: 'chat',
      })
      const run = store.createAgentRun({
        workspaceId: workspace.id, worldId: world.id, turnId: turn.id,
        sessionId: direct.id, employeeId: employee.id, ordinal: 1,
      })
      const composed = await composer.compose({
        employee,
        persona,
        conversationId: direct.id,
        prompt,
        history: [],
        observedThroughSequence: 0,
        workTurnId: turn.id,
      })
      return snapshots.save({ agentRunId: run.id, envelope: composed.envelope })!
    }

    const first = await composeFor('你是一位人事顾问。', '第一问')
    expect(first.cache.prefixReused).toBe(false)
    expect(first.cache.stablePrefixTokens).toBeGreaterThan(0)

    const second = await composeFor('你是一位人事顾问。', '第二问')
    expect(second.cache.prefixReused).toBe(true)
    expect(second.cache.previousStablePrefixHash).toBe(first.stablePrefixHash)

    const third = await composeFor('你是一位法务顾问。', '第三问')
    expect(third.cache.prefixReused).toBe(false)
    expect(third.cache.previousStablePrefixHash).toBe(second.stablePrefixHash)
  })

  it('drops a text field a caller tries to smuggle into a snapshot layer', async () => {
    const { store, workspace, world, employee } = await setup()
    const direct = session(store, workspace, world, employee, 'direct')
    const turn = store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId: direct.id, interactionKind: 'chat',
    })
    const run = store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, turnId: turn.id,
      sessionId: direct.id, employeeId: employee.id, ordinal: 1,
    })
    store.saveAgentRunContextSnapshot({
      agentRunId: run.id,
      snapshot: {
        snapshotVersion: 1,
        envelopeVersion: 1,
        stablePrefixHash: 'h',
        structureHash: 's',
        totalTokenEstimate: 3,
        layers: [{
          id: 'identity',
          kind: 'stable-identity',
          revision: 'r',
          contentHash: 'c',
          tokenEstimate: 3,
          sourceRefs: [],
          text: 'SMUGGLED-PROMPT-9001',
        } as never],
        cache: { stablePrefixTokens: 3, volatileTokens: 0, prefixReused: false },
      },
    })
    expect(JSON.stringify(storedRow(store, run.id))).not.toContain('SMUGGLED-PROMPT-9001')
  })

  it('composes a snapshot deterministically from an envelope alone', async () => {
    const { store, workspace, world, employee } = await setup()
    const direct = session(store, workspace, world, employee, 'direct')
    const composer = new ConversationContextComposer(store, undefined)
    const composed = await composer.compose({
      employee,
      persona: '你是一位人事顾问。',
      conversationId: direct.id,
      prompt: '同一个问题',
      history: [],
      observedThroughSequence: 0,
    })
    const left = composeContextSnapshot({ envelope: composed.envelope })
    const right = composeContextSnapshot({ envelope: composed.envelope })
    expect(left).toEqual(right)
    expect(JSON.stringify(left)).not.toContain('同一个问题')
    expect(JSON.stringify(left)).not.toContain('人事顾问')
  })
})
