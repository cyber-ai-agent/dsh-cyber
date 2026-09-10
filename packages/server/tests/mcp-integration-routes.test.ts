import type { ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'
import type { IntegrationConnection } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../src/http/errors.js'
import { Router } from '../src/http/router.js'
import type { IntegrationService } from '../src/integrations/integration-service.js'
import { MCP_INTEGRATION_ID } from '../src/integrations/mcp-provider.js'
import { registerIntegrationRoutes } from '../src/routes/integration-routes.js'

function mcpConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  const now = new Date().toISOString()
  return {
    id: 'mcp-1',
    workspaceId: 'ws-1',
    integrationId: MCP_INTEGRATION_ID,
    displayName: 'MCP',
    config: { service: 'github', endpoint: 'http://127.0.0.1:3900/mcp' },
    enabled: true,
    credentialConfigured: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

type FakeRequest = { method: string; url: string; headers: Record<string, unknown>; [Symbol.asyncIterator](): AsyncGenerator<Buffer> }

function fakeRequest(method: string, url: string, body?: Record<string, unknown>): FakeRequest {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return {
    method,
    url,
    headers: {},
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
    // The route only touches writeHead/end/headersSent.
    response: response as unknown as ServerResponse,
    result: () => ({ status, payload: JSON.parse(body || '{}') as Record<string, unknown> }),
  }
}

function mount(siblings: IntegrationConnection[]) {
  const saved: unknown[] = []
  const store = { getWorkspace: (id: string) => (id === 'ws-1' ? { id: 'ws-1' } : undefined) } as unknown as SqliteStore
  const integrations = {
    listByType: (_workspaceId: string, integrationId: string) => (integrationId === MCP_INTEGRATION_ID ? siblings : []),
    save: async (input: unknown) => { saved.push(input); return mcpConnection({ id: 'new', config: (input as { config?: JsonObject }).config ?? {} }) },
  } as unknown as IntegrationService
  const router = new Router()
  registerIntegrationRoutes(router, { store, integrations, onChanged: async () => undefined })
  return { router, saved }
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

type JsonObject = Record<string, unknown>

describe('MCP connection service uniqueness', () => {
  it('rejects a new service whose slug already exists in the workspace', async () => {
    const siblings = [
      mcpConnection({ id: 'a', config: { service: 'github', endpoint: 'http://127.0.0.1:3900/mcp' } }),
      mcpConnection({ id: 'b', config: { service: 'linear', endpoint: 'http://127.0.0.1:3901/mcp' } }),
    ]
    const { router, saved } = mount(siblings)
    const out = await call(router, fakeRequest('PUT', `/api/workspaces/ws-1/integrations/${MCP_INTEGRATION_ID}`, { config: { service: 'github', endpoint: 'http://127.0.0.1:3902/mcp' }, enabled: true }))
    expect(out.status).toBe(409)
    expect(out.payload.error?.code).toBe('mcp_service_duplicate')
    expect(saved).toHaveLength(0)
  })

  it('allows a new service with a unique slug', async () => {
    const siblings = [mcpConnection({ id: 'a', config: { service: 'github', endpoint: 'http://127.0.0.1:3900/mcp' } })]
    const { router, saved } = mount(siblings)
    const out = await call(router, fakeRequest('PUT', `/api/workspaces/ws-1/integrations/${MCP_INTEGRATION_ID}`, { config: { service: 'notion', endpoint: 'http://127.0.0.1:3903/mcp' }, enabled: true }))
    expect(out.status).toBe(200)
    expect(saved).toHaveLength(1)
  })

  it('rejects a blank service slug', async () => {
    const { router, saved } = mount([])
    const out = await call(router, fakeRequest('PUT', `/api/workspaces/ws-1/integrations/${MCP_INTEGRATION_ID}`, { config: { service: '', endpoint: 'http://127.0.0.1:3904/mcp' }, enabled: true }))
    expect(out.status).toBe(422)
    expect(out.payload.error?.code).toBe('mcp_service_invalid')
    expect(saved).toHaveLength(0)
  })

  it('does not gate a non-MCP connection type', async () => {
    const { router, saved } = mount([])
    const out = await call(router, fakeRequest('PUT', '/api/workspaces/ws-1/integrations/builtin.ssh-device', { config: { host: '192.168.1.10' }, enabled: true }))
    expect(out.status).toBe(200)
    expect(saved).toHaveLength(1)
  })
})
