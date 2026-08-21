import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, AgentTurnResult } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { extractHttpStatus } from '../src/services/model-interaction-service.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

class FakeRuntime implements AgentRuntimePort {
  fail = false
  /** 模拟 worker 空回复：发 turn.failed 事件但不抛异常（502 类错误的典型形态） */
  silentFail = false

  async runTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    if (this.silentFail) {
      request.onEvent?.({
        kind: 'turn.started',
        source: 'test-runtime',
        sourceSessionId: agentSessionId,
        metadata: {},
      })
      request.onEvent?.({
        kind: 'turn.failed',
        source: 'test-runtime',
        sourceSessionId: agentSessionId,
        failed: true,
        metadata: { errorCode: 'empty-response', error: 'model returned no content', httpStatus: 502 },
      })
      return { agentSessionId, finalResponse: '', eventCount: 2 }
    }
    if (this.fail) {
      request.onEvent?.({
        kind: 'turn.started',
        source: 'test-runtime',
        sourceSessionId: agentSessionId,
        metadata: {},
      })
      request.onEvent?.({
        kind: 'turn.failed',
        source: 'test-runtime',
        sourceSessionId: agentSessionId,
        failed: true,
        metadata: { errorCode: 'upstream-500' },
      })
      throw new Error('upstream model error')
    }
    request.onEvent?.({
      kind: 'turn.started',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'tool.started',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      toolName: 'search_workspace',
      callId: `call-${request.agent.id}`,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'tool.completed',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      callId: `call-${request.agent.id}`,
      failed: false,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'assistant.message',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      content: '我先建立性能基线。',
      metadata: {},
    })
    request.onEvent?.({
      kind: 'turn.completed',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      metadata: {},
    })
    return { agentSessionId, finalResponse: '我先建立性能基线。', eventCount: 5 }
  }

  async close(): Promise<void> {}
}

async function start(stateRoot: string, runtime = new FakeRuntime()) {
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
  })
  servers.push(server)
  const address = await server.start()
  return { server, runtime, origin: address.origin }
}

async function json(
  origin: string,
  pathname: string,
  init?: RequestInit,
): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${pathname}`, init)
  return { response, body: await response.json() }
}

async function createWorld(origin: string) {
  const workspaceResult = await json(origin, '/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '日志工作区' }),
  })
  const workspace = workspaceResult.body.workspace as { id: string }
  const worldResult = await json(origin, `/api/workspaces/${workspace.id}/worlds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '赛博公司', templateId: 'cyber-company' }),
  })
  return { workspace, world: worldResult.body.world as { id: string } }
}

async function recruit(origin: string, worldId: string, blueprintId: string) {
  const result = await json(origin, `/api/worlds/${worldId}/recruit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blueprintId, blueprintVersion: 1 }),
  })
  return result.body.employee as { id: string; displayName: string }
}

async function chat(origin: string, worldId: string, prompt: string) {
  return json(origin, `/api/worlds/${worldId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
}

describe('Model interaction log APIs', () => {
  it('records successful turn interactions and exposes list, filter, detail and clear APIs', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-interactions-'))
    const { origin } = await start(stateRoot)
    const { workspace, world } = await createWorld(origin)

    const engineer = await recruit(origin, world.id, 'cyber-company.software-engineer')

    // 配置模型档案并分配给员工，验证日志记录到真实 modelId / provider
    const profileResult = await json(origin, `/api/workspaces/${workspace.id}/model-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'profile-deepseek',
        displayName: '公司 DeepSeek',
        providerKind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        modelId: 'deepseek-chat',
        api: 'openai-completions',
      }),
    })
    expect(profileResult.response.status).toBe(201)
    await json(origin, `/api/workspaces/${workspace.id}/model-assignments/employee/${engineer.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelProfileId: 'profile-deepseek' }),
    })

    const reply = await chat(origin, world.id, '@开发工程师 请建立性能基线')
    expect(reply.response.status).toBe(200)
    expect(reply.body.replies[0].content).toBe('我先建立性能基线。')

    const list = await json(origin, `/api/workspaces/${workspace.id}/model-interactions`)
    expect(list.response.status).toBe(200)
    expect(list.body.total).toBe(1)
    expect(list.body.modelIds).toEqual(['deepseek-chat'])
    const log = list.body.items[0]
    expect(log).toMatchObject({
      source: 'turn',
      modelId: 'deepseek-chat',
      provider: '公司 DeepSeek',
      status: 'success',
      toolCallCount: 1,
      promptMessageCount: 2,
    })
    expect(log.promptCharCount).toBeGreaterThan(0)
    expect(log.responseCharCount).toBe('我先建立性能基线。'.length)
    expect(log.durationMs).toBeGreaterThanOrEqual(0)
    // 隐私：日志不包含 prompt 明文与密钥
    expect(JSON.stringify(log)).not.toContain('请建立性能基线')

    // 详情
    const detail = await json(origin, `/api/workspaces/${workspace.id}/model-interactions/${log.id}`)
    expect(detail.response.status).toBe(200)
    expect(detail.body.log.id).toBe(log.id)

    // 状态筛选
    const failedFilter = await json(origin, `/api/workspaces/${workspace.id}/model-interactions?status=failed`)
    expect(failedFilter.body.total).toBe(0)
    const successFilter = await json(origin, `/api/workspaces/${workspace.id}/model-interactions?status=success`)
    expect(successFilter.body.total).toBe(1)

    // 模型筛选
    const modelFilter = await json(origin, `/api/workspaces/${workspace.id}/model-interactions?modelId=${encodeURIComponent('deepseek-chat')}`)
    expect(modelFilter.body.total).toBe(1)
    const wrongModel = await json(origin, `/api/workspaces/${workspace.id}/model-interactions?modelId=${encodeURIComponent('other-model')}`)
    expect(wrongModel.body.total).toBe(0)

    // 非法状态筛选
    const badStatus = await json(origin, `/api/workspaces/${workspace.id}/model-interactions?status=bogus`)
    expect(badStatus.response.status).toBe(422)

    // 清空（服务端护栏要求非 GET 请求带 application/json）
    const cleared = await json(origin, `/api/workspaces/${workspace.id}/model-interactions`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(cleared.response.status).toBe(200)
    expect(cleared.body.removed).toBe(1)
    const afterClear = await json(origin, `/api/workspaces/${workspace.id}/model-interactions`)
    expect(afterClear.body.total).toBe(0)
  })

  it('records failed turn interactions with error codes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-interactions-'))
    const runtime = new FakeRuntime()
    const { origin } = await start(stateRoot, runtime)
    const { workspace, world } = await createWorld(origin)
    await recruit(origin, world.id, 'cyber-company.software-engineer')

    runtime.fail = true
    await chat(origin, world.id, '@开发工程师 触发失败')

    const list = await json(origin, `/api/workspaces/${workspace.id}/model-interactions`)
    expect(list.body.total).toBe(1)
    expect(list.body.items[0]).toMatchObject({
      source: 'turn',
      modelId: 'dsh-default',
      provider: '默认 DSH 模型',
      status: 'failed',
      errorCode: 'upstream-500',
    })
    expect(typeof list.body.items[0].errorMessage).toBe('string')
  })

  it('records failed turns with http status when worker emits turn.failed without throwing', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-interactions-'))
    const runtime = new FakeRuntime()
    const { origin } = await start(stateRoot, runtime)
    const { workspace, world } = await createWorld(origin)
    await recruit(origin, world.id, 'cyber-company.software-engineer')

    runtime.silentFail = true
    const reply = await chat(origin, world.id, '@开发工程师 触发空回复')
    // worker 未抛异常，但 turn.failed 事件 → orchestrator 判定失败，返回 502
    expect(reply.response.status).toBe(502)

    const list = await json(origin, `/api/workspaces/${workspace.id}/model-interactions`)
    expect(list.body.total).toBe(1)
    const log = list.body.items[0]
    expect(log).toMatchObject({
      source: 'turn',
      status: 'failed',
      errorCode: 'empty-response',
      httpStatus: 502,
    })
    expect(log.errorMessage).toContain('model returned no content')
  })

  it('records failed /models discovery interactions', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-interactions-'))
    const { origin } = await start(stateRoot)
    const { workspace } = await createWorld(origin)

    // 指向无人监听的回环端口，必然连接失败 → 记录 discovery 失败日志
    const discovery = await json(origin, `/api/workspaces/${workspace.id}/model-profiles/discover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions' }),
    })
    expect(discovery.response.status).toBeGreaterThanOrEqual(400)

    const list = await json(origin, `/api/workspaces/${workspace.id}/model-interactions`)
    expect(list.body.total).toBe(1)
    const log = list.body.items[0]
    expect(log).toMatchObject({
      source: 'discovery',
      modelId: '-',
      provider: 'http://127.0.0.1:9/v1',
      status: 'failed',
      errorCode: 'model_catalog_unreachable',
      promptMessageCount: 0,
      promptCharCount: 0,
    })
  })
})

describe('extractHttpStatus', () => {
  it('extracts numeric status fields from error objects', () => {
    expect(extractHttpStatus({ status: 429 })).toBe(429)
    expect(extractHttpStatus({ statusCode: 503 })).toBe(503)
    expect(extractHttpStatus({ status: '502' })).toBe(502)
  })

  it('extracts status codes embedded in error text', () => {
    expect(extractHttpStatus(new Error('HTTP 500 Internal Server Error'))).toBe(500)
    expect(extractHttpStatus(new Error('upstream returned status: 401'))).toBe(401)
    expect(extractHttpStatus(new Error('request failed (429)'))).toBe(429)
  })

  it('returns undefined when no status code is present', () => {
    expect(extractHttpStatus(new Error('network unreachable'))).toBeUndefined()
    expect(extractHttpStatus(undefined)).toBeUndefined()
    expect(extractHttpStatus('some plain message')).toBeUndefined()
  })
})
