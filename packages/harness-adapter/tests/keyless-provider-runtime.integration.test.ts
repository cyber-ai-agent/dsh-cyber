import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimeEvent, AgentTurnRequest, EmployeeInstance, EmployeeRevision } from '@dsh-cyber/contracts'

import { HarnessModelRouter, runHarnessCandidateCanary, type HarnessModelRoute } from '../src/index.js'

const servers: Server[] = []
const routers: HarnessModelRouter[] = []

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
    server.closeAllConnections()
  })))
})

const employee: EmployeeInstance = {
  id: 'keyless-employee', workspaceId: 'keyless-workspace', worldId: 'keyless-world',
  blueprintId: 'keyless-role', blueprintVersion: 1, displayName: '本地模型验证', role: '验证',
  status: 'available', currentRevision: 1,
  createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
}
const revision: EmployeeRevision = {
  employeeId: employee.id, revision: 1, persona: '只报告工具返回的真实结果。',
  skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'local-provider-test',
  createdAt: employee.createdAt,
}

describe('credential-free private provider through the real Harness router', () => {
  it('reaches the model, executes a read tool, and continues after a restart without configuring a key', async () => {
    const requests: Array<{ authorization?: string; body: Record<string, unknown>; url?: string }> = []
    const root = await mkdtemp(join(tmpdir(), 'cyber-keyless-runtime-'))
    const fixturePath = join(root, 'fixture.txt')
    await writeFile(fixturePath, 'KEYLESS-TOOL-EVIDENCE', 'utf8')
    const baseURL = await provider(async (request, response) => {
      const body = await readJson(request)
      requests.push({ authorization: request.headers.authorization, body, url: request.url })
      streamCompletion(response, requests.length === 1
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: {
            name: 'read', arguments: JSON.stringify({ file_path: fixturePath }),
          } }] }
        : { role: 'assistant', content: 'KEYLESS-HARNESS-OK' }, requests.length === 1 ? 'tool_calls' : 'stop')
    })
    const route = modelRoute(baseURL, { requiresApiKey: false })
    const request = turn(root)
    const firstRouter = routerFor(route, root)
    const result = await firstRouter.runTurn(request)
    expect(result.finalResponse).toBe('KEYLESS-HARNESS-OK')
    expect(requests).toHaveLength(2)
    expect(requests.every((entry) => entry.url === '/v1/chat/completions')).toBe(true)
    expect(requests.every((entry) => entry.authorization === 'Bearer dsh-cyber-local-no-auth')).toBe(true)
    expect(JSON.stringify(requests[0]?.body.tools)).toContain('read')
    expect(JSON.stringify(requests[1]?.body.messages)).toContain('KEYLESS-TOOL-EVIDENCE')
    await firstRouter.close()

    const restored = await routerFor(route, root).runTurn({
      ...request,
      history: [{ role: 'assistant', sequence: 1, speakerId: employee.id, speakerName: employee.displayName,
        createdAt: employee.createdAt, content: result.finalResponse }],
      observedThroughSequence: 1,
      prompt: '重启后继续受控验证。',
    })
    expect(restored.finalResponse).toBe('KEYLESS-HARNESS-OK')
    expect(requests).toHaveLength(3)
    expect(JSON.stringify(requests[2]?.body.messages)).toContain('KEYLESS-HARNESS-OK')

    const canary = await runHarnessCandidateCanary({
      candidateRoot: resolve('packages/harness-adapter'), stateRoot: join(root, 'canary'), workspacePath: root,
      inheritedEnvironment: process.env, route,
    })
    expect(canary.ok).toBe(true)
    expect(requests).toHaveLength(5)
    expect(requests.every((entry) => entry.authorization === 'Bearer dsh-cyber-local-no-auth')).toBe(true)
  }, 90_000)

  it('passes a configured local credential unchanged instead of replacing it with the marker', async () => {
    const authorizations: Array<string | undefined> = []
    const baseURL = await provider(async (request, response) => {
      authorizations.push(request.headers.authorization)
      await readJson(request)
      streamCompletion(response, { role: 'assistant', content: 'CONFIGURED-KEY-OK' }, 'stop')
    })
    const root = await mkdtemp(join(tmpdir(), 'cyber-keyless-configured-'))
    const result = await routerFor(modelRoute(baseURL, { apiKeyEnv: 'CYBER_TEST_CONFIGURED_LOCAL_KEY' }), root,
      { CYBER_TEST_CONFIGURED_LOCAL_KEY: 'fixture-key-only' }).runTurn(turn(root))
    expect(result.finalResponse).toBe('CONFIGURED-KEY-OK')
    expect(authorizations).toEqual(['Bearer fixture-key-only'])
  }, 90_000)

  it('still surfaces authentication rejection from a configured no-key endpoint', async () => {
    let requests = 0
    const baseURL = await provider(async (request, response) => {
      requests += 1
      await readJson(request)
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'This fixture requires authentication', type: 'invalid_request_error', code: 'invalid_api_key' } }))
    })
    const root = await mkdtemp(join(tmpdir(), 'cyber-keyless-rejected-'))
    const events: AgentRuntimeEvent[] = []
    const result = await routerFor(modelRoute(baseURL, { requiresApiKey: false }), root)
      .runTurn({ ...turn(root), onEvent: (event) => events.push(event) })
    expect(result.finalResponse).toBe('')
    expect(JSON.stringify(events.filter((event) => event.kind === 'turn.failed'))).toMatch(/401|authentication|invalid_api_key/i)
    expect(requests).toBe(1)
  }, 90_000)

  it.each([true, undefined])('does not treat a missing required credential as local no-auth (%s)', async (requiresApiKey) => {
    let requests = 0
    const baseURL = await provider(async (_request, response) => {
      requests += 1
      streamCompletion(response, { role: 'assistant', content: 'UNEXPECTED' }, 'stop')
    })
    const root = await mkdtemp(join(tmpdir(), 'cyber-keyless-required-'))
    const route = modelRoute(baseURL, requiresApiKey === undefined ? {} : { requiresApiKey })
    const events: AgentRuntimeEvent[] = []
    const result = await routerFor(route, root).runTurn({ ...turn(root), onEvent: (event) => events.push(event) })
    expect(result.finalResponse).toBe('')
    expect(JSON.stringify(events.filter((event) => event.kind === 'turn.failed'))).toMatch(/API key|authentication|credential/i)
    expect(requests).toBe(0)
  }, 90_000)

  it('preserves fail-loud validation when a local route names an unset key', async () => {
    let requests = 0
    const baseURL = await provider(async (_request, response) => {
      requests += 1
      streamCompletion(response, { role: 'assistant', content: 'UNEXPECTED' }, 'stop')
    })
    const root = await mkdtemp(join(tmpdir(), 'cyber-keyless-named-key-'))
    const events: AgentRuntimeEvent[] = []
    const result = await routerFor(modelRoute(baseURL, { apiKeyEnv: 'CYBER_TEST_ABSENT_LOCAL_KEY' }), root)
      .runTurn({ ...turn(root), onEvent: (event) => events.push(event) })
    expect(result.finalResponse).toBe('')
    expect(JSON.stringify(events.filter((event) => event.kind === 'turn.failed'))).toMatch(/credential|CYBER_TEST_ABSENT_LOCAL_KEY/i)
    expect(requests).toBe(0)
  }, 90_000)
})

function modelRoute(baseURL: string, options: Partial<HarnessModelRoute>): HarnessModelRoute {
  return { id: 'keyless-profile', displayName: '本地受控模型', api: 'openai-completions', baseURL,
    modelId: 'local-keyless-fixture', contextWindow: 32_768, maxTokens: 512, ...options }
}

function routerFor(route: HarnessModelRoute, stateRoot: string, environment: NodeJS.ProcessEnv = {}): HarnessModelRouter {
  const router = new HarnessModelRouter({
    stateRoot, resolveRoute: () => route, resolveWebSearchPlan: () => ({ kind: 'disabled' }),
    inheritedEnvironment: { ...process.env, ...environment, CYBER_TEST_ABSENT_LOCAL_KEY: undefined },
  })
  routers.push(router)
  return router
}

function turn(workspacePath: string): AgentTurnRequest {
  return { agent: employee, revision, conversationId: 'keyless-conversation', history: [], observedThroughSequence: 0,
    workspacePath, permissionMode: 'read-only', prompt: '读取受控文件，然后报告结果。' }
}

async function provider(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => response.writeHead(500).end())
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

function streamCompletion(response: ServerResponse, delta: Record<string, unknown>, finishReason: string): void {
  const envelope = { id: 'keyless-completion', object: 'chat.completion.chunk', created: 1_777_777_777, model: 'local-keyless-fixture' }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const value of request) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}
