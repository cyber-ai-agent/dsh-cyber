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
} from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'
import { EmployeeConversationMemoryService } from '../src/services/employee-conversation-memory-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

class CaptureRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return { agentSessionId: 'agent-session', finalResponse: '好的。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'context.runtime.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责测试上下文运行时',
    persona: '你只引用自己真实参与过的经历。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-runtime-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '上下文世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'context.runtime.worker',
    blueprintVersion: 1,
  })
  return { store, workspace, world, employee, memory: new EmployeeConversationMemoryService(store) }
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

describe('CharacterProfileRuntime context composition', () => {
  it('hands the runtime lane only the recent raw turns and retrieves the rest', async () => {
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
    for (let index = 1; index <= 12; index += 1) {
      const turn = store.createWorkTurn({
        workspaceId: workspace.id,
        worldId: world.id,
        sessionId: session.id,
        interactionKind: 'chat',
      })
      store.appendMessage({
        sessionId: session.id,
        senderId: 'owner',
        senderKind: 'owner',
        kind: 'user',
        content: index === 1 ? '把老仓库的迁移方案记下来' : `第 ${index} 轮请求`,
        metadata: { workTurnId: turn.id },
      })
      store.appendMessage({
        sessionId: session.id,
        senderId: employee.id,
        senderKind: 'employee',
        kind: 'assistant',
        content: index === 1 ? '老仓库迁移方案已记录：先冻结写入，再灰度切换。' : `第 ${index} 轮回答`,
        metadata: { workTurnId: turn.id, agentRunId: `run-${index}` },
      })
      await memory.rememberCompletedRun({
        employeeId: employee.id,
        sessionId: session.id,
        workTurnId: turn.id,
        agentRunId: `run-${index}`,
      })
    }
    const entries = history(store, session.id, employee)
    const inner = new CaptureRuntime()
    const runtime = new CharacterProfileRuntime(inner, store)

    await runtime.runTurn({
      agent: employee,
      revision: store.getEmployeeRevision(employee.id, employee.currentRevision)!,
      conversationId: session.id,
      history: entries,
      observedThroughSequence: 0,
      prompt: '老仓库迁移方案当时怎么定的？',
      workspacePath: '/tmp/world',
    })

    const captured = inner.requests[0]!
    expect(captured.history.length).toBeLessThan(entries.length)
    expect(captured.history).toEqual(entries.slice(entries.length - captured.history.length))
    expect(captured.prompt).toContain('[当前请求]')
    expect(captured.prompt).toContain('老仓库迁移方案')
    // observedThroughSequence stays the durable cursor, untouched by trimming.
    expect(captured.observedThroughSequence).toBe(0)
  })
})
