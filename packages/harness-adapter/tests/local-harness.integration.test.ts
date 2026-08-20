import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
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
    const adapter = new HarnessCompatibilityAdapter({
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

    try {
      const first = await adapter.runEmployeeTurn({
        employee,
        revision,
        prompt: '第一轮：确认本地 Harness 会话。',
        workspacePath: stateRoot,
      })
      const second = await adapter.runEmployeeTurn({
        employee: { ...employee, agentSessionId: first.agentSessionId },
        revision,
        prompt: '第二轮：继续同一会话。',
        workspacePath: stateRoot,
      })

      expect(first.finalResponse).toContain('LOCAL-HARNESS-OK')
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

    const canary = await runHarnessCandidateCanary({
      candidateRoot: resolve('.'),
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
      version: '0.1.0-rc.7',
      stableSession: true,
    })
    expect(canary.eventKinds).toEqual(expect.arrayContaining(['turn.started', 'assistant.message', 'turn.completed']))
    expect(requests).toHaveLength(4)
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
