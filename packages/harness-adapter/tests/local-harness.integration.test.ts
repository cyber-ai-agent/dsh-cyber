import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeInstance, EmployeeRevision } from '@dsh-cyber/contracts'

import {
  HarnessCompatibilityAdapter,
  normalizeHarnessNotification,
  runHarnessCandidateCanary,
} from '../src/index.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer))
})

describe('real Harness worker with a loopback model provider', () => {
  it('enforces native file scopes and same-turn approval in real workers', async () => {
    // DSH intentionally permits platform temporary directories in workspace
    // mode; an outside-workspace denial must be tested outside that exception.
    await mkdir(resolve('.private'), { recursive: true })
    const root = await mkdtemp(join(resolve('.private'), 'dsh-cyber-native-scopes-'))
    const workspacePath = join(root, 'project')
    await mkdir(workspacePath)
    const cases = [
      { mode: 'read-only', outside: false, written: false },
      { mode: 'workspace-write', outside: false, written: true },
      { mode: 'workspace-write', outside: true, written: false },
      { mode: 'read-only', outside: false, written: true, decision: 'approved' },
      { mode: 'read-only', outside: false, written: false, decision: 'rejected' },
      { mode: 'danger-full-access', outside: true, written: true },
    ] as const
    let active: { path: string; escalate: boolean } = { path: '', escalate: false }
    let calls = 0
    const provider = createServer((request, response) => {
      void (async () => {
        await readJson(request)
        calls += 1
        const envelope = { id: `scope-${calls}`, object: 'chat.completion.chunk', created: 1_777_777_777, model: 'local-test' }
        const args = { file_path: active.path, content: 'VERIFIED-NATIVE-WRITE',
          ...(active.escalate ? { sandbox_permissions: 'workspace-write', justification: '测试项目内文件的单次写入审批' } : {}) }
        const delta = calls === 1
          ? { role: 'assistant', tool_calls: [{ index: 0, id: 'scope-write', type: 'function', function: { name: 'write', arguments: JSON.stringify(args) } }] }
          : { role: 'assistant', content: 'SCOPE-TEST-COMPLETE' }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch(() => response.writeHead(500).end())
    })
    servers.push(provider)
    await listen(provider)
    const address = provider.address() as AddressInfo
    for (const [index, scenario] of cases.entries()) {
      const decision = 'decision' in scenario ? scenario.decision : undefined
      active = { path: join(scenario.outside ? root : workspacePath, `scope-${index}.txt`), escalate: decision !== undefined }
      calls = 0
      const adapter = new HarnessCompatibilityAdapter({ stateRoot: join(root, `runtime-${index}`), provider: 'local-scopes', model: 'local-test',
        inheritedEnvironment: { ...process.env, DSH_CYBER_LOCAL_TEST_KEY: 'local-test-only' },
        providerProfile: { route: 'local-scopes', displayName: 'Local scope test', api: 'openai-completions',
          apiKeyEnv: 'DSH_CYBER_LOCAL_TEST_KEY',
          baseURL: `http://127.0.0.1:${address.port}/v1`, model: { id: 'local-test', contextWindow: 8192, maxTokens: 512 } } })
      const employee: EmployeeInstance = { id: 'scope-employee', workspaceId: 'scope-workspace', worldId: 'scope-world', blueprintId: 'scope-role',
        blueprintVersion: 1, displayName: '权限验证', role: '验证', status: 'available', currentRevision: 1,
        createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' }
      const revision: EmployeeRevision = { employeeId: employee.id, revision: 1, persona: '根据工具事实回答', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: employee.createdAt }
      const approvals: Array<Promise<void>> = []
      try {
        const result = await adapter.runEmployeeTurn({ employee, revision, workspacePath, conversationId: `scope-chat-${index}`, agentRunId: `scope-run-${index}`,
          history: [], observedThroughSequence: 0, permissionMode: scenario.mode, prompt: '执行受控写入测试',
          onNotification(notification) {
            for (const event of normalizeHarnessNotification(notification)) {
              if (event.kind === 'approval.requested') approvals.push(adapter.decideApproval(`scope-run-${index}`, String(event.metadata.approvalRequestId), decision ?? 'rejected'))
            }
          },
        })
        await Promise.all(approvals)
        expect(result.finalResponse, JSON.stringify({ calls, events: result.notifications.flatMap(normalizeHarnessNotification) })).toContain('SCOPE-TEST-COMPLETE')
        const content = await readFile(active.path, 'utf8').catch(() => undefined)
        expect(content, `${scenario.mode}, outside=${scenario.outside}, decision=${decision}`).toBe(scenario.written ? 'VERIFIED-NATIVE-WRITE' : undefined)
        expect(approvals.length).toBe(decision === undefined ? 0 : 1)
      } finally { await adapter.close() }
    }
  }, 90_000)

  it('runs and resumes one persistent employee session without cloud access', async () => {
    const requests: Array<Record<string, unknown>> = []
    let responseNumber = 0
    const provider = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404).end()
          return
        }
        const body = await readJson(request)
        requests.push(body)
        responseNumber += 1
        const content = responseNumber === 1
          ? 'LOCAL-HARNESS-OK：已建立独立员工会话。'
          : 'LOCAL-HARNESS-CONTINUED：已从同一员工会话继续。'
        const envelope = {
          id: `chatcmpl-local-${responseNumber}`,
          object: 'chat.completion.chunk',
          created: 1_777_777_777,
          model: 'local-test',
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        response.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          ...envelope,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        })}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end(error instanceof Error ? error.message : String(error))
      })
    })
    servers.push(provider)
    await listen(provider)
    const address = provider.address() as AddressInfo

    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-real-harness-'))
    const employee: EmployeeInstance = {
      id: 'local-employee',
      workspaceId: 'local-workspace',
      worldId: 'local-world',
      blueprintId: 'local-engineer',
      blueprintVersion: 1,
      displayName: '本地员工',
      role: '验证工程师',
      status: 'available',
      currentRevision: 1,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }
    const revision: EmployeeRevision = {
      employeeId: employee.id,
      revision: 1,
      persona: '只报告真实运行结果。',
      skillGrants: [],
      capabilityGrants: [],
      modelPolicy: {},
      reason: 'integration-test',
      createdAt: '2026-08-20T00:00:00.000Z',
    }
    const createAdapter = () => new HarnessCompatibilityAdapter({
      stateRoot,
      model: 'local-test',
      provider: 'local-integration',
      inheritedEnvironment: {
        ...process.env,
        DSH_CYBER_LOCAL_TEST_KEY: 'local-test-only',
      },
      providerProfile: {
        route: 'local-integration',
        displayName: 'Loopback integration provider',
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        apiKeyEnv: 'DSH_CYBER_LOCAL_TEST_KEY',
        model: { id: 'local-test', contextWindow: 8_192, maxTokens: 512 },
      },
    })

    const adapter = createAdapter()
    let firstSessionId: string | undefined
    try {
      const first = await adapter.runEmployeeTurn({
        employee,
        revision,
        conversationId: 'conversation-local-integration',
        history: [],
        observedThroughSequence: 0,
        prompt: '第一轮：确认本地 Harness 会话。',
        workspacePath: stateRoot,
      })
      // The same conversation keeps the same worker session inside one process.
      // The employee's last runtime session id is not threaded back in: it is a
      // diagnostic field, never the reason a session resumes.
      const second = await adapter.runEmployeeTurn({
        employee,
        revision,
        conversationId: 'conversation-local-integration',
        history: [],
        observedThroughSequence: 0,
        prompt: '第二轮：继续同一会话。',
        workspacePath: stateRoot,
      })

      expect(first.finalResponse).toContain('LOCAL-HARNESS-OK')
      firstSessionId = first.agentSessionId
      expect(second.finalResponse).toContain('LOCAL-HARNESS-CONTINUED')
      expect(second.agentSessionId).toBe(first.agentSessionId)
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1])).toContain('LOCAL-HARNESS-OK')
      expect(JSON.stringify(requests[1])).toContain('第二轮：继续同一会话。')

      const eventKinds = [...first.notifications, ...second.notifications]
        .flatMap(normalizeHarnessNotification)
        .map((event) => event.kind)
      expect(eventKinds).toContain('turn.started')
      expect(eventKinds).toContain('assistant.message')
      expect(eventKinds).toContain('turn.completed')
    } finally {
      await adapter.close()
    }

    const restarted = createAdapter()
    try {
      const restored = await restarted.runEmployeeTurn({
        employee, revision,
        conversationId: 'conversation-local-integration',
        history: [{ role: 'assistant', sequence: 2, speakerId: employee.id, speakerName: employee.displayName,
          createdAt: employee.createdAt, content: 'LOCAL-HARNESS-OK：已建立独立员工会话。' }],
        observedThroughSequence: 2,
        prompt: '重启后继续', workspacePath: stateRoot,
      })
      expect(restored.agentSessionId).not.toBe(firstSessionId)
      expect(JSON.stringify(requests[2]).split('LOCAL-HARNESS-OK')).toHaveLength(2)
      expect(JSON.stringify(requests[2])).toContain('recovered_conversation_history')
    } finally {
      await restarted.close()
    }

    const canary = await runHarnessCandidateCanary({
      candidateRoot: resolve('packages/harness-adapter'),
      stateRoot: join(stateRoot, 'candidate-canary'),
      workspacePath: stateRoot,
      inheritedEnvironment: {
        ...process.env,
        DSH_CYBER_LOCAL_TEST_KEY: 'local-test-only',
      },
      route: {
        id: 'local-integration',
        displayName: 'Loopback integration provider',
        api: 'openai-completions',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        modelId: 'local-test',
        apiKeyEnv: 'DSH_CYBER_LOCAL_TEST_KEY',
        contextWindow: 8_192,
        maxTokens: 512,
      },
    })
    expect(canary).toMatchObject({
      ok: true,
      version: '0.1.2-rc.1',
      stableSession: true,
    })
    expect(canary.eventKinds).toEqual(expect.arrayContaining(['turn.started', 'assistant.message', 'turn.completed']))
    expect(requests).toHaveLength(5)
  }, 90_000)
})

function listen(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error))
  })
}

async function readJson(request: NodeJS.AsyncIterable<Buffer | string>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const value of request) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
