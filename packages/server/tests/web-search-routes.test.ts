import type { ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'
import { WEB_SEARCH_WORKER_TOKEN_HEADER, type IntegrationConnection } from '@dsh-cyber/contracts'

import { HttpError } from '../src/http/errors.js'
import { Router } from '../src/http/router.js'
import type { IntegrationService } from '../src/integrations/integration-service.js'
import { TEST_CATALOG } from './web-search-test-catalog.js'
import { registerWebSearchRoutes } from '../src/routes/web-search-routes.js'

function legacyFirecrawlConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  const now = new Date().toISOString()
  return {
    id: 'fc-1',
    workspaceId: 'ws-1',
    integrationId: 'builtin.firecrawl',
    displayName: 'Firecrawl',
    config: { baseUrl: 'https://api.firecrawl.dev', isDefault: true },
    enabled: true,
    credentialConfigured: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

type FakeRequest = { method?: string; url?: string; headers: Record<string, unknown>; [Symbol.asyncIterator](): AsyncGenerator<Buffer> }

function fakeRequest(method: 'GET' | 'POST', url: string, body?: Record<string, unknown>, token?: string): FakeRequest {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    method,
    url,
    headers: token === undefined ? {} : { [WEB_SEARCH_WORKER_TOKEN_HEADER]: token },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
}

function fakeResponse() {
  let status = 0
  let body = ''
  const response = {
    headersSent: false,
    writeHead(code: number): void { status = code },
    end(chunk?: string): void { body = chunk ?? '' },
  }
  return {
    // Cast at the call site; the route only touches writeHead/end/headersSent.
    response: response as unknown as ServerResponse,
    result: () => ({ status, payload: JSON.parse(body || '{}') as Record<string, unknown> }),
  }
}

function mount(options: { legacyFirecrawl?: IntegrationConnection; credentials?: Record<string, string | undefined>; fetchImpl?: typeof globalThis.fetch }): Router {
  const legacyFirecrawl = options.legacyFirecrawl
  const credentials = options.credentials ?? {}
  const integrations = {
    listByType: (_workspaceId: string, integrationId: string) => (legacyFirecrawl?.integrationId === integrationId ? [legacyFirecrawl] : []),
    get: (_workspaceId: string, integrationId: string) => (legacyFirecrawl?.integrationId === integrationId ? legacyFirecrawl : undefined),
    credentialForConnection: (_workspaceId: string, connectionId: string) => credentials[connectionId],
  } as unknown as IntegrationService
  const router = new Router()
  registerWebSearchRoutes(router, {
    integrations,
    workerToken: 'tok',
    catalog: () => TEST_CATALOG,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
  })
  return router
}

/** Run the route the way the dispatcher does: a thrown HttpError becomes its status. */
async function call(router: Router, request: FakeRequest): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { response, result } = fakeResponse()
  try {
    await router.dispatch(request as never, response as never)
    return result()
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, payload: { error: { code: error.code } } }
    throw error
  }
}

function firecrawlPayload(): string {
  return JSON.stringify({ data: { web: [{ url: 'https://github.com/deepseek-ai/dsh', title: 'DSH', description: 'DeepSeek harness' }] } })
}

describe('provider catalog route', () => {
  it('serves the checked-in catalog to the 联网搜索 cards', async () => {
    const out = await call(mount({}), fakeRequest('GET', '/api/integrations/web-search/providers'))
    expect(out.status).toBe(200)
    expect(out.payload.catalog).toMatchObject({ schemaVersion: 1, version: 'test', providers: [{ id: 'deepseek' }, { id: 'firecrawl' }] })
  })
})

describe('worker 联网搜索 bridge route', () => {
  it('rejects a missing or wrong worker token', async () => {
    const router = mount({ legacyFirecrawl: legacyFirecrawlConnection(), credentials: { 'fc-1': 'sk-x' } })
    for (const token of [undefined, 'wrong']) {
      const out = await call(router, fakeRequest('POST', '/api/integrations/firecrawl/search', { workspaceId: 'ws-1', query: 'x' }, token))
      expect(out.status).toBe(401)
    }
  })

  it('refuses when no Firecrawl 联网搜索 connection is active', async () => {
    const out = await call(mount({}), fakeRequest('POST', '/api/integrations/firecrawl/search', { workspaceId: 'ws-1', query: 'x' }, 'tok'))
    expect(out.status).toBe(409)
    expect(out.payload.error?.code).toBe('web_search_not_configured')
  })

  it('refuses a Firecrawl connection without a stored key', async () => {
    const out = await call(mount({ legacyFirecrawl: legacyFirecrawlConnection() }), fakeRequest('POST', '/api/integrations/firecrawl/search', { workspaceId: 'ws-1', query: 'x' }, 'tok'))
    expect(out.status).toBe(409)
  })

  it('runs the search against the legacy Firecrawl credential and returns normalized sources', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (_input: unknown, init?: RequestInit) => {
      captured = { url: String(_input), init }
      return Promise.resolve(new Response(firecrawlPayload(), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }
    const router = mount({ legacyFirecrawl: legacyFirecrawlConnection(), credentials: { 'fc-1': 'sk-secret' }, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch })
    const out = await call(router, fakeRequest('POST', '/api/integrations/firecrawl/search', { workspaceId: 'ws-1', query: 'dsh', limit: 3 }, 'tok'))
    expect(out.status).toBe(200)
    expect(captured.url).toBe('https://api.firecrawl.dev/v2/search')
    expect(captured.init?.headers).toMatchObject({ Authorization: 'Bearer sk-secret' })
    expect(out.payload.sources).toEqual([{ url: 'https://github.com/deepseek-ai/dsh', title: 'DSH', snippet: 'DeepSeek harness' }])
    expect(out.payload.truncated).toBe(false)
  })
})
