import { describe, expect, it } from 'vitest'
import type {
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  ContextLayer,
  EmployeeInstance,
  EmployeeRevision,
  WorkMessage,
} from '@dsh-cyber/contracts'
import { composeContextLayer, estimateTextTokens, type ContextBudgetPlan } from '@dsh-cyber/contracts'

import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'
import type { EnvironmentSnapshot } from '../src/environments/environment-service.js'
import type { EnvironmentSignal } from '../src/environments/environment-change-collector.js'

class CaptureRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []
  readonly events: AgentRuntimeEvent[] = []
  /** Tool traffic the fake lane emits before it answers. */
  script: AgentRuntimeEvent[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    for (const event of this.script) request.onEvent?.(event)
    request.onEvent?.({
      kind: 'assistant.message',
      source: 'test',
      sourceSessionId: 'agent-session-1',
      content: '环境档案已注入。',
      metadata: {},
    })
    return {
      agentSessionId: request.agent.agentSessionId ?? 'new-agent-session',
      finalResponse: '环境档案已注入。',
      eventCount: 1 + this.script.length,
    }
  }

  async close(): Promise<void> {}
}

function environmentLayer(text: string, id = 'environment:local'): ContextLayer {
  return composeContextLayer({ id, kind: 'environment', text, sourceRefs: [{ kind: 'environment', id: 'local', revision: 'e'.repeat(32) }] })
}

function snapshotOf(layer: ContextLayer, present: string[] = []): EnvironmentSnapshot {
  return { layer, present }
}

function character(overrides: Partial<EmployeeInstance> = {}): EmployeeInstance {
  return {
    id: 'character-1',
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId: 'core.butler',
    blueprintVersion: 1,
    displayName: '管家',
    role: '世界管家',
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  }
}

function revision(): EmployeeRevision {
  return {
    employeeId: 'character-1',
    revision: 1,
    persona: '基础人设',
    skillGrants: [],
    capabilityGrants: [],
    modelPolicy: {},
    reason: '测试角色版本',
    createdAt: '2026-08-21T00:00:00.000Z',
  }
}

function pinnedMessage(pinned: Record<string, unknown>): WorkMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    sequence: 5,
    senderId: 'character-1',
    senderKind: 'employee',
    kind: 'assistant',
    content: '上一轮回复',
    metadata: { contextEnvironmentLayer: pinned },
    createdAt: '2026-08-21T00:00:00.000Z',
  }
}

function runTurnRequest(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    agent: character(),
    revision: revision(),
    prompt: '继续',
    workspacePath: '/tmp/world',
    conversationId: 'conversation-1',
    history: [],
    observedThroughSequence: 0,
    ...overrides,
  }
}

function storeWithMessages(messages: WorkMessage[]) {
  return {
    getEmployee: () => character(),
    getEmployeeRevision: () => revision(),
    getEmployeeProfile: () => undefined,
    getWorld: () => ({ id: 'world-1', workspaceId: 'workspace-1', name: '测试世界', templateId: 'personal-world', status: 'active', administratorEmployeeId: 'character-1', createdAt: '', updatedAt: '' }),
    // The context composer only composes when the session lookup exists;
    // returning undefined keeps the lane 'unknown', which is what the
    // injection assertions are about, not session shape.
    getSession: () => undefined,
    listMessages: () => messages,
  }
}

describe('CharacterProfileRuntime environment injection', () => {
  it('injects the live environment layer behind the directory layer and into the stable prefix', async () => {
    const inner = new CaptureRuntime()
    const live = environmentLayer('[本机环境档案]\n系统: Windows x64 · shell: pwsh\n已安装: git 2.45.0, node v20.11.1')
    let portCalls = 0
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      async snapshot() {
        portCalls += 1
        return snapshotOf(live, ['git', 'node'])
      },
    })

    await runtime.runTurn(runTurnRequest({ onEvent: (event) => { inner.events.push(event) } }))

    expect(portCalls).toBe(1)
    const request = inner.requests[0]!
    // The layer text lands in the rendered prefix, behind the identity.
    expect(request.revision.persona).toContain('[本机环境档案]')
    expect(request.revision.persona.indexOf('[本机环境档案]')).toBeGreaterThan(request.revision.persona.indexOf('基础人设'))
    // The envelope describes it for the inspector and the cache decision.
    expect(request.contextSourceRefs?.some((ref) => ref.kind === 'environment')).toBe(true)
  })

  it('keeps the lane pinned to the revision it first saw and reports the change in one volatile line', async () => {
    const inner = new CaptureRuntime()
    const live = environmentLayer('[本机环境档案]\n系统: macOS arm64 · shell: zsh\n已安装: git, node')
    const pinned = {
      text: '[本机环境档案]\n系统: macOS arm64 · shell: zsh\n已安装: git, node, pnpm',
      revision: 'pinned-revision',
      present: ['git', 'node', 'pnpm'],
    }
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([pinnedMessage(pinned)]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      async snapshot() {
        return snapshotOf(live, ['git', 'node'])
      },
    })

    await runtime.runTurn(runTurnRequest({ observedThroughSequence: 5, onEvent: (event) => { inner.events.push(event) } }))

    const request = inner.requests[0]!
    // The prefix still carries exactly what the lane pinned.
    expect(request.revision.persona).toContain('已安装: git, node, pnpm')
    expect(request.revision.persona).not.toContain('已安装: git, node\n')
    // The delta is stated once, in the volatile suffix, naming the lost tool.
    expect(request.prompt).toContain('[系统提示] 机器档案已更新：不再可用：pnpm')
    // The stable prefix hash is untouched by the notice.
    expect(request.promptCache?.stablePrefixHash).toBeDefined()
    const stamp = inner.events.find((event) => event.kind === 'assistant.message')!.metadata.contextEnvironmentLayer as Record<string, unknown>
    expect(stamp).toMatchObject({ revision: 'pinned-revision', noticedRevision: live.revision, present: ['git', 'node', 'pnpm'] })
  })

  it('does not repeat a change already announced to the lane', async () => {
    const inner = new CaptureRuntime()
    const live = environmentLayer('[本机环境档案]\n系统: Linux x86_64 · shell: bash\n已安装: go')
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([pinnedMessage({
      text: '[本机环境档案]\n系统: Linux x86_64 · shell: bash\n已安装: go, rustc',
      revision: 'pinned-revision',
      present: ['go', 'rustc'],
      noticedRevision: live.revision,
    })]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      async snapshot() {
        return snapshotOf(live, ['go'])
      },
    })

    await runtime.runTurn(runTurnRequest({ observedThroughSequence: 5 }))

    expect(inner.requests[0]!.prompt).not.toContain('[系统提示] 机器档案已更新')
  })

  it('stamps the pinned layer onto durable assistant events of the lane', async () => {
    const inner = new CaptureRuntime()
    const live = environmentLayer('[本机环境档案]\n系统: Linux x86_64 · shell: bash\n已安装: go, rustc')
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      async snapshot() {
        return snapshotOf(live, ['go', 'rustc'])
      },
    })

    await runtime.runTurn(runTurnRequest({ onEvent: (event) => { inner.events.push(event) } }))

    const assistant = inner.events.filter((event) => event.kind === 'assistant.message')
    expect(assistant.length).toBeGreaterThan(0)
    for (const event of assistant) {
      expect(event.metadata.contextEnvironmentLayer).toMatchObject({
        id: live.id,
        text: live.text,
        revision: live.revision,
        sourceRefs: live.sourceRefs,
        present: ['go', 'rustc'],
        noticedRevision: live.revision,
      })
    }
  })

  it('counts the environment layer inside the fixed input budget', async () => {
    const inner = new CaptureRuntime()
    const live = environmentLayer('[本机环境档案]\n系统: Windows x64 · shell: pwsh\n已安装: git 2.45.0\n未安装: docker')
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      async snapshot() {
        return snapshotOf(live, ['git'])
      },
    })
    const rawPersona = revision().persona
    const fixedTokens = estimateTextTokens(rawPersona) + estimateTextTokens('继续')
    const budget: ContextBudgetPlan = {
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      safetyMarginTokens: 1_638,
      inputBudgetTokens: 32_768 - 8_192 - 1_638,
      fixedTokens,
      workingTokens: 4_000,
      historyTokens: 4_000,
      memoryTokens: 1_000,
      knowledgeTokens: 1_400,
    }

    await runtime.runTurn(runTurnRequest({ contextBudget: budget }))

    const forwarded = inner.requests[0]!.contextBudget!
    // The rebuilt allocation counted the environment text into the fixed part.
    expect(forwarded.fixedTokens).toBeGreaterThan(budget.fixedTokens)
    expect(forwarded.inputBudgetTokens).toBe(budget.inputBudgetTokens)
  })

  it('folds host-observed tool traffic into the profile after the turn', async () => {
    const inner = new CaptureRuntime()
    inner.script = [
      {
        kind: 'tool.started',
        source: 'test',
        sourceSessionId: 'agent-session-1',
        callId: 'call-1',
        toolName: 'pwsh',
        metadata: { toolSummary: 'ffmpeg -version' },
      },
      {
        kind: 'tool.completed',
        source: 'test',
        sourceSessionId: 'agent-session-1',
        callId: 'call-1',
        toolName: 'pwsh',
        failed: false,
        metadata: { toolOutput: 'ffmpeg version 7.1', toolExitCode: 0 },
      },
      {
        kind: 'tool.started',
        source: 'test',
        sourceSessionId: 'agent-session-1',
        callId: 'call-2',
        toolName: 'pwsh',
        metadata: { toolSummary: 'docker ps' },
      },
      {
        kind: 'tool.completed',
        source: 'test',
        sourceSessionId: 'agent-session-1',
        callId: 'call-2',
        toolName: 'pwsh',
        failed: true,
        metadata: { toolOutput: "'docker' is not recognized as an internal or external command", toolExitCode: 1 },
      },
    ]
    const live = environmentLayer('[本机环境档案]\n系统: Windows x64 · shell: pwsh\n已安装: node\n未安装: ffmpeg, docker')
    const applied: EnvironmentSignal[][] = []
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      async snapshot() {
        return snapshotOf(live, ['node'])
      },
      async applySignals(signals) {
        applied.push([...signals])
      },
    })

    await runtime.runTurn(runTurnRequest({ onEvent: (event) => { inner.events.push(event) } }))

    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual([
      { failed: false, toolName: 'pwsh', command: 'ffmpeg -version', output: 'ffmpeg version 7.1', exitCode: 0 },
      { failed: true, toolName: 'pwsh', command: 'docker ps', output: "'docker' is not recognized as an internal or external command", exitCode: 1 },
    ])
  })

  it('leaves the prompt untouched for embedders without an environment port', async () => {
    const inner = new CaptureRuntime()
    const runtime = new CharacterProfileRuntime(inner, storeWithMessages([]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined)

    await runtime.runTurn(runTurnRequest())

    expect(inner.requests[0]!.revision.persona).not.toContain('[本机环境档案]')
  })
})
