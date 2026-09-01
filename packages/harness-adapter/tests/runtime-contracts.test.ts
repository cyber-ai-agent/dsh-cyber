import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekHarness, type SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-client'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  AgentRuntimeEvent,
  AgentTurnRequest,
  EmployeeInstance,
  EmployeeRevision,
} from '@dsh-cyber/contracts'

import {
  HarnessCompatibilityAdapter,
  HarnessModelRouter,
  normalizeHarnessNotification,
  type HarnessRuntime,
} from '../src/index.js'

const adapters: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()))
})

const employee: EmployeeInstance = {
  id: 'contract-employee',
  workspaceId: 'contract-workspace',
  worldId: 'contract-world',
  blueprintId: 'contract-role',
  blueprintVersion: 1,
  displayName: '合同角色',
  role: '兼容性测试角色',
  presence: 'available',
  health: 'healthy',
  status: 'available',
  currentRevision: 1,
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
}

const revision: EmployeeRevision = {
  employeeId: employee.id,
  revision: 1,
  persona: '只报告可验证的合同事实。',
  skillGrants: [],
  capabilityGrants: [],
  modelPolicy: {},
  reason: 'contract-test',
  createdAt: '2026-08-31T00:00:00.000Z',
}

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    agent: employee,
    revision,
    conversationId: 'contract-conversation',
    history: [],
    observedThroughSequence: 0,
    prompt: '验证 Harness 合同',
    workspacePath: tmpdir(),
    ...overrides,
  }
}

function sessionEvent(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
): HarnessNotification {
  return {
    method: 'session.event',
    params: { sessionId, event: { type, seq: 1, time: 1_000, data } },
  }
}

describe('Harness adapter runtime contracts', () => {
  it('passes alpha3 encoded image content blocks to one SDK session without flattening or re-encoding them', async () => {
    const promptCalls: Array<{ sessionId: string; contentBlocks: SdkPromptContentBlock[] }> = []
    let notificationIndex = 0
    const notifications: HarnessNotification[] = [
      {
        method: 'session.event',
        params: {
          sessionId: 'image-contract-session',
          event: {
            type: 'agent/inbox/spliced',
            seq: 1,
            time: 1_000,
            data: { inserted: [{ id: 'image-contract-message' }] },
          },
        },
      },
      {
        method: 'session.event',
        params: {
          sessionId: 'image-contract-session',
          event: {
            type: 'assistant/message',
            seq: 2,
            time: 1_001,
            data: { message: { content: [{ type: 'text', text: '已读取图片' }] } },
          },
        },
      },
      {
        method: 'session.status',
        params: { sessionId: 'image-contract-session', status: 'idle' },
      },
    ]
    const client = {
      start() {},
      async initialize() { return { serverInfo: { name: 'test', version: '0.1.2-alpha.3' } } },
      async prompt(sessionId: string, contentBlocks: SdkPromptContentBlock[]) {
        promptCalls.push({ sessionId, contentBlocks })
        return 'image-contract-message'
      },
      subscribeSessionTree() {
        return {
          async next() { return notifications[notificationIndex++]! },
          close() {},
        }
      },
      async close() {},
    }
    const TestHarness = DeepSeekHarness as unknown as new (
      options: Record<string, never>,
      clientFactory: () => typeof client,
    ) => DeepSeekHarness
    const harness = new TestHarness({}, () => client)
    const blocks: SdkPromptContentBlock[] = [
      { type: 'text', text: '请查看' },
      { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      { type: 'text', text: '并总结' },
    ]

    await expect(harness.run(blocks, { sessionId: 'image-contract-session' })).resolves.toMatchObject({
      finalResponse: '已读取图片',
    })
    expect(promptCalls).toEqual([{ sessionId: 'image-contract-session', contentBlocks: blocks }])
    await harness.close()
  })

  it('tolerates alpha3 notifications and unknown content blocks while retaining visible text', () => {
    const ignored = {
      method: 'session.event',
      params: {
        sessionId: 'contract-conversation',
        event: { type: 'plugin/telemetry', seq: 1, time: 1_000, ignorable: true, data: { sample: 'not a turn fact' } },
      },
    }
    expect(normalizeHarnessNotification(ignored)).toEqual([])
    expect(normalizeHarnessNotification({
      method: 'session.status',
      params: { sessionId: 'contract-conversation', status: 'running' },
    })).toEqual([])
    expect(normalizeHarnessNotification({
      method: 'subagent.started',
      params: { parentSessionId: 'contract-conversation', childSessionId: 'child' },
    })).toEqual([])

    const events = normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'contract-conversation',
        event: {
          type: 'assistant/message',
          seq: 2,
          time: 1_001,
          data: {
            message: {
              content: [
                {
                  type: 'image',
                  attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 1 },
                },
                { type: 'text', text: '图片旁的可见文字' },
              ],
            },
          },
        },
      },
    })
    expect(events).toEqual([expect.objectContaining({ kind: 'assistant.message', content: '图片旁的可见文字' })])
  })

  it('ignores an unknown live event without treating its data as a Cyber runtime fact', () => {
    expect(normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'contract-conversation',
        event: { type: 'plugin/required-fact', seq: 3, time: 1_002, data: { mustDecode: true } },
      },
    })).toEqual([])
  })

  it('returns provider token usage from a completed turn without inventing missing counts', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-contract-token-'))
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory: () => ({
        async run(sessionId, _prompt, onNotification) {
          const completed = sessionEvent(sessionId, 'turn/end', {
            reason: { kind: 'completed' },
            usage: { inputTokens: 37, outputTokens: 11, totalTokens: 48 },
          })
          onNotification?.(completed)
          return { finalResponse: '已完成', notifications: [completed] }
        },
        async close() {},
      }),
    })
    adapters.push(adapter)

    const events: AgentRuntimeEvent[] = []
    const result = await adapter.runTurn(request({ onEvent: (event) => events.push(event) }))

    expect(result).toMatchObject({
      finalResponse: '已完成',
      tokenUsage: { prompt: 37, completion: 11, total: 48 },
      eventCount: 1,
    })
    expect(events).toEqual([expect.objectContaining({
      kind: 'turn.completed',
      metadata: { reason: 'completed', tokensPrompt: 37, tokensCompletion: 11, tokensTotal: 48 },
    })])
  })

  it('routes an approval decision to the exact active AgentRun and resumes that turn', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-contract-approval-'))
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let release!: () => void
    const decisions: Array<{ approvalRequestId: string; decision: 'approved' | 'rejected' }> = []
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory: () => {
        const runtime: HarnessRuntime = {
          async run(sessionId, _prompt, onNotification) {
            const asked = sessionEvent(sessionId, 'approval/asked', {
              id: 'approval-contract-1',
              toolName: 'write_file',
              callId: 'call-contract-1',
              reason: '需要用户确认写入',
            })
            onNotification?.(asked)
            return await new Promise<{ finalResponse: string; notifications: HarnessNotification[] }>((resolve) => {
              release = () => {
                const decided = sessionEvent(sessionId, 'approval/decided', {
                  id: 'approval-contract-1',
                  outcome: 'allowed-once',
                })
                onNotification?.(decided)
                resolve({ finalResponse: '审批后完成', notifications: [asked, decided] })
              }
              markStarted()
            })
          },
          async decideApproval(approvalRequestId, decision) {
            decisions.push({ approvalRequestId, decision })
            release()
          },
          async close() {},
        }
        return runtime
      },
    })
    adapters.push(adapter)

    const events: AgentRuntimeEvent[] = []
    const running = adapter.runTurn(request({
      agentRunId: 'run-contract-approval',
      onEvent: (event) => events.push(event),
    }))
    await started
    await adapter.decideApproval('run-contract-approval', 'approval-contract-1', 'approved')

    await expect(running).resolves.toMatchObject({ finalResponse: '审批后完成' })
    expect(decisions).toEqual([{ approvalRequestId: 'approval-contract-1', decision: 'approved' }])
    expect(events.map((event) => event.kind)).toEqual(['approval.requested', 'approval.decided'])
  })

  it('recreates the affected Harness runtime after a worker crash and retries once before visible output', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-contract-crash-'))
    let runtimeCreates = 0
    let closeCalls = 0
    const sessionIds: string[] = []
    const router = new HarnessModelRouter({
      stateRoot,
      resolveRoute: () => undefined,
      adapterFactory: (options) => new HarnessCompatibilityAdapter({
        ...options,
        runtimeFactory: () => {
          runtimeCreates += 1
          const generation = runtimeCreates
          return {
            async run(sessionId) {
              sessionIds.push(sessionId)
              if (generation === 1) throw new Error('DeepSeek Harness worker exited unexpectedly')
              return { finalResponse: '崩溃后恢复', notifications: [] }
            },
            async close() { closeCalls += 1 },
          }
        },
      }),
    })
    adapters.push(router)

    await expect(router.runTurn(request({ agentRunId: 'run-contract-crash' }))).resolves.toMatchObject({
      finalResponse: '崩溃后恢复',
    })
    expect(runtimeCreates).toBe(2)
    expect(sessionIds).toHaveLength(2)
    expect(sessionIds[0]).not.toBe(sessionIds[1])
    expect(closeCalls).toBe(1)
  })

  it('does not retry a crashed turn after the runtime has emitted visible output', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-contract-crash-output-'))
    let runtimeCreates = 0
    const router = new HarnessModelRouter({
      stateRoot,
      resolveRoute: () => undefined,
      adapterFactory: (options) => new HarnessCompatibilityAdapter({
        ...options,
        runtimeFactory: () => {
          runtimeCreates += 1
          return {
            async run(sessionId, _prompt, onNotification) {
              onNotification?.(sessionEvent(sessionId, 'assistant/message', {
                message: { content: [{ type: 'text', text: '已经输出一部分' }] },
              }))
              throw new Error('DeepSeek Harness worker exited unexpectedly')
            },
            async close() {},
          }
        },
      }),
    })
    adapters.push(router)

    await expect(router.runTurn(request({ agentRunId: 'run-contract-crash-output' }))).rejects.toThrow('worker exited')
    expect(runtimeCreates).toBe(1)
  })
})
