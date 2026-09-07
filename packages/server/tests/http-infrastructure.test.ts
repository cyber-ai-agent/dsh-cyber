import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import { AgentTurnFailedError, type ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { WorldRuntimeSnapshot, WorldRuntimeStreamEnvelope } from '@dsh-cyber/contracts'

import { HttpError, writeError } from '../src/http/errors.js'
import { Router, matchRoute } from '../src/http/router.js'
import { RuntimeStreamHub } from '../src/streams/runtime-stream-hub.js'
import { WorldStreamHub } from '../src/streams/world-stream-hub.js'
import { ServiceError } from '../src/services/service-error.js'

class FakeResponse {
  readonly chunks: string[] = []
  statusCode = 0
  headers: Record<string, string | number> = {}
  headersSent = false
  writableEnded = false
  destroyed = false

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
    return this
  }

  write(value: string | Buffer): boolean {
    this.chunks.push(String(value))
    return true
  }

  end(value?: string | Buffer): this {
    if (value !== undefined) this.chunks.push(String(value))
    this.writableEnded = true
    return this
  }

  text(): string {
    return this.chunks.join('')
  }
}

function request(
  url: string,
  headers: IncomingMessage['headers'] = {},
): IncomingMessage & EventEmitter {
  const value = new EventEmitter() as IncomingMessage & EventEmitter
  Object.assign(value, { method: 'GET', url, headers })
  return value
}

function response(): { fake: FakeResponse; node: ServerResponse } {
  const fake = new FakeResponse()
  return { fake, node: fake as unknown as ServerResponse }
}

const snapshot: WorldRuntimeSnapshot = {
  contractVersion: 1,
  workspaceId: 'workspace-1',
  worldId: 'world-1',
  templateId: 'company',
  themeId: 'builtin',
  sceneId: 'main',
  sequence: 7,
  generatedAt: '2026-08-20T00:00:00.000Z',
  clock: {
    now: '2026-08-20T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    lightsOn: true,
  },
  entities: [],
  objects: [],
  growthSlots: {},
}

describe('Router', () => {
  it('matches exact and parameterized routes in registration order', async () => {
    const router = new Router()
    const calls: string[] = []
    router.get(/^\/api\/worlds\/([^/]+)$/, ({ params }) => {
      calls.push(`first:${params[0]}`)
    })
    router.get(/^\/api\/worlds\/([^/]+)$/, () => {
      calls.push('second')
    })
    router.post('/api/worlds', () => {
      calls.push('post')
    })

    const handled = await router.dispatch(
      request('/api/worlds/world%20one'),
      response().node,
    )

    expect(handled).toBe(true)
    expect(calls).toEqual(['first:world one'])
    expect(matchRoute('/api/health', '/api/health')).toEqual([])
    expect(matchRoute('/api/unknown', '/api/health')).toBeUndefined()
  })

  it('returns false when no method/path pair matches', async () => {
    const router = new Router()
    router.post('/api/worlds', () => undefined)
    await expect(router.dispatch(request('/api/worlds'), response().node)).resolves.toBe(false)
  })
})

describe('HTTP error mapping', () => {
  it('preserves explicit status, code, and message', () => {
    const { fake, node } = response()
    writeError(node, new HttpError(409, 'conflict', 'Already active'))

    expect(fake.statusCode).toBe(409)
    expect(JSON.parse(fake.text())).toEqual({
      error: { code: 'conflict', message: 'Already active', messageKey: 'error.conflict' },
    })
  })

  it('does not disclose unexpected error details', () => {
    const { fake, node } = response()
    writeError(node, new Error('private detail'))

    expect(fake.statusCode).toBe(500)
    expect(JSON.parse(fake.text())).toEqual({
      error: { code: 'internal_error', message: '服务器内部错误', messageKey: 'error.internal_error' },
    })
  })

  it('maps application errors without coupling services to HTTP responses', () => {
    const { fake, node } = response()
    writeError(node, new ServiceError('too-large', 'preview_too_large', 'Preview is too large'))

    expect(fake.statusCode).toBe(413)
    expect(JSON.parse(fake.text())).toEqual({
      error: { code: 'preview_too_large', message: 'Preview is too large', messageKey: 'error.preview_too_large' },
    })
  })

  it('turns model authentication failures into an actionable Chinese error', () => {
    const { fake, node } = response()
    writeError(node, new AgentTurnFailedError('employee-private-id', 'authentication'))

    expect(fake.statusCode).toBe(502)
    expect(JSON.parse(fake.text())).toEqual({
      error: {
        code: 'model_turn_authentication',
        message: 'API 密钥被模型服务拒绝。请打开“设置 → 模型”重新填写密钥，并先获取模型列表确认连接成功。',
        messageKey: 'error.model_turn_authentication',
      },
    })
    expect(fake.text()).not.toContain('employee-private-id')
  })

  it('maps context-limit failures to 413 with numeric limits and no prompt details', () => {
    const { fake, node } = response()
    writeError(node, new AgentTurnFailedError('employee-private-id', 'context-limit', {
      estimatedTokens: 32_768,
      inputBudgetTokens: 4_096,
    }))

    expect(fake.statusCode).toBe(413)
    const payload = JSON.parse(fake.text()) as { error: Record<string, unknown> }
    expect(payload.error).toMatchObject({
      code: 'model_turn_context_limit',
      estimatedTokens: 32_768,
      inputBudgetTokens: 4_096,
    })
    expect(String(payload.error.message)).toContain('上下文')
    expect(fake.text()).not.toContain('employee-private-id')
    expect(fake.text()).not.toContain('prompt')
  })

  it('keeps a known context refusal at 413 when numeric usage is unavailable', () => {
    const { fake, node } = response()
    writeError(node, new AgentTurnFailedError('employee', 'context-limit'))
    expect(fake.statusCode).toBe(413)
    expect(JSON.parse(fake.text()).error).toMatchObject({ code: 'model_turn_context_limit' })
    expect(JSON.parse(fake.text()).error).not.toHaveProperty('estimatedTokens')
  })
})

describe('stream lifecycle', () => {
  it('registers, filters, disconnects, and closes runtime clients', () => {
    const hub = new RuntimeStreamHub(60_000)
    const incoming = request('/api/worlds/world-1/live')
    const { fake, node } = response()
    hub.connect('world-1', incoming, node)

    const event: ConversationRealtimeEnvelope = {
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      sessionId: 'session-1',
      agentId: 'employee-1',
      event: {
        kind: 'turn.started',
        source: 'test',
        sourceSessionId: 'agent-session-1',
        sourceSequence: 1,
        metadata: {},
      },
    }
    hub.publish(event)
    hub.publishWorld({
      contractVersion: 1,
      id: '8',
      worldId: 'world-1',
      sequence: 8,
      kind: 'world-state',
      payload: {},
      createdAt: '2026-08-20T00:00:01.000Z',
    })
    hub.publishWorld({
      contractVersion: 1,
      id: '8:runtime',
      worldId: 'world-1',
      sequence: 8,
      kind: 'runtime',
      payload: {},
      createdAt: '2026-08-20T00:00:01.000Z',
    })

    expect(hub.clientCount).toBe(1)
    expect(fake.text()).toContain('event: ready')
    expect(fake.text()).toContain('event: runtime')
    expect(fake.text()).toContain('event: world-state')
    expect(fake.text()).toContain('event: world-runtime')
    incoming.emit('close')
    expect(hub.clientCount).toBe(0)
    hub.close()
  })

  it('recovers a stale world cursor, advances sequence, and avoids replay on exact reconnect', () => {
    const hub = new WorldStreamHub(60_000)
    const staleRequest = request('/api/worlds/world-1/stream?after=5')
    const stale = response()
    hub.connect('world-1', staleRequest, stale.node, snapshot, '5')

    expect(stale.fake.text()).toContain('event: recovery-required')
    expect(stale.fake.text()).toContain('event: world-state')
    expect(stale.fake.text()).not.toContain('event: world-cue')

    const update: WorldRuntimeStreamEnvelope = {
      contractVersion: 1,
      id: '8',
      worldId: 'world-1',
      sequence: 8,
      kind: 'world-state',
      payload: {},
      createdAt: '2026-08-20T00:00:01.000Z',
    }
    hub.publish(update)
    expect(stale.fake.text()).toContain('id: 8')

    staleRequest.emit('close')
    const exactRequest = request('/api/worlds/world-1/stream', { 'last-event-id': '7' })
    const exact = response()
    hub.connect('world-1', exactRequest, exact.node, snapshot, null)
    expect(exact.fake.text()).toContain('event: ready')
    expect(exact.fake.text()).not.toContain('recovery-required')
    expect(hub.clientCount).toBe(1)

    hub.close()
    expect(hub.clientCount).toBe(0)
    expect(exact.fake.writableEnded).toBe(true)
  })
})
