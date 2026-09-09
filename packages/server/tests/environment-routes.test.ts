import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { EnvironmentProfile } from '@dsh-cyber/contracts'

import { EnvironmentProfileStore } from '../src/environments/environment-store.js'
import { EnvironmentService } from '../src/environments/environment-service.js'
import { HttpError } from '../src/http/errors.js'
import { Router } from '../src/http/router.js'
import { registerIntegrationRoutes } from '../src/routes/integration-routes.js'
import { registerSystemRoutes } from '../src/routes/system-routes.js'

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cyber-env-routes-'))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function profile(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  return {
    schemaVersion: 1,
    profileId: 'local',
    os: 'windows',
    arch: 'x64',
    shell: 'powershell',
    tools: {
      node: { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: 'v20.11.1' },
      ffmpeg: { present: false, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z' },
    },
    notes: [],
    probedAt: '2026-08-21T00:00:00.000Z',
    fastSignature: 'a'.repeat(32),
    fullDirty: false,
    ...overrides,
  }
}

class FakeResponse {
  readonly chunks: string[] = []
  statusCode = 0
  headersSent = false
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this }
  write(value: string | Buffer): boolean { this.chunks.push(String(value)); return true }
  end(value?: string | Buffer): this { if (value !== undefined) this.chunks.push(String(value)); return this }
  text(): string { return this.chunks.join('') }
}

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const request = new EventEmitter() as IncomingMessage & AsyncIterable<Buffer>
  Object.assign(request, { method, url, headers: {} })
  request[Symbol.asyncIterator] = async function* iterator() {
    if (payload !== undefined) yield payload
  }
  return request
}

interface Call {
  status: number
  body: Record<string, unknown>
}

async function call(router: Router, method: string, url: string, body?: unknown): Promise<Call> {
  const response = new FakeResponse()
  try {
    await router.dispatch(fakeRequest(method, url, body), response as unknown as ServerResponse)
  } catch (cause) {
    if (cause instanceof HttpError) return { status: cause.status, body: { code: cause.code } }
    throw cause
  }
  return { status: response.statusCode, body: JSON.parse(response.text() || '{}') as Record<string, unknown> }
}

function routerWith(service: EnvironmentService): Router {
  const router = new Router()
  registerSystemRoutes(router, {
    store: {} as never,
    stateRoot: tempRoot(),
    runtimeUpdates: {} as never,
    applicationUpdates: {} as never,
    environments: service,
  })
  return router
}

describe('environment routes', () => {
  it('reads the stored profile and answers null before one exists', async () => {
    const service = new EnvironmentService(new EnvironmentProfileStore(tempRoot()), { probe: async () => profile() })
    const router = routerWith(service)

    const missing = await call(router, 'GET', '/api/environments/local')
    expect(missing.status).toBe(200)
    expect(missing.body.profile).toBeNull()

    await service.refreshLocal('fast')
    const found = await call(router, 'GET', '/api/environments/local')
    expect(found.status).toBe(200)
    expect((found.body.profile as EnvironmentProfile).tools.node?.version).toBe('v20.11.1')
  })

  it('refreshes at the requested tier and rejects an unknown one', async () => {
    const tiers: string[] = []
    const service = new EnvironmentService(new EnvironmentProfileStore(tempRoot()), {
      probe: async (tier) => {
        tiers.push(tier)
        return profile()
      },
    })
    const router = routerWith(service)

    // An explicit owner refresh defaults to the full tier.
    const refreshed = await call(router, 'POST', '/api/environments/local/refresh', {})
    expect(refreshed.status).toBe(200)
    expect(tiers).toEqual(['full'])

    await call(router, 'POST', '/api/environments/local/refresh', { tier: 'fast' })
    expect(tiers).toEqual(['full', 'fast'])

    const invalid = await call(router, 'POST', '/api/environments/local/refresh', { tier: 'deep' })
    expect(invalid.status).toBe(422)
    expect(invalid.body.code).toBe('environment_tier_invalid')
  })

  it('adds and removes an owner-declared CLI, and rejects a name that is not one', async () => {
    const service = new EnvironmentService(new EnvironmentProfileStore(tempRoot()), {
      probe: async () => profile(),
      probeCustomTool: async () => ({ present: true, version: '3.1.4' }),
      clock: () => '2026-08-21T00:00:00.000Z',
    })
    await service.refreshLocal('full')
    const router = routerWith(service)

    const added = await call(router, 'POST', '/api/environments/local/tools', { name: 'My-Tool' })
    expect(added.status).toBe(201)
    const tools = (added.body.profile as EnvironmentProfile).tools
    expect(tools['my-tool']).toMatchObject({ present: true, source: 'custom', version: '3.1.4' })

    // A name is a name: a command line is not one.
    const rejected = await call(router, 'POST', '/api/environments/local/tools', { name: 'ffmpeg -i x' })
    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe('environment_tool_name_invalid')

    const removed = await call(router, 'DELETE', '/api/environments/local/tools/my-tool')
    expect(removed.status).toBe(200)
    expect((removed.body.profile as EnvironmentProfile).tools['my-tool']).toBeUndefined()

    const missing = await call(router, 'DELETE', '/api/environments/local/tools/my-tool')
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('environment_tool_not_found')

    // A built-in entry is not the owner's to delete.
    const builtin = await call(router, 'DELETE', '/api/environments/local/tools/node')
    expect(builtin.status).toBe(404)
  })

  it('probes one device on request, keyed by its connection', async () => {
    const service = new EnvironmentService(new EnvironmentProfileStore(tempRoot()), {
      probe: async () => profile(),
      clock: () => '2026-08-21T00:00:00.000Z',
      probeDevice: async (target, tier) => ({
        ...profile({ profileId: target.profileId, os: 'linux', arch: 'x86_64', shell: 'bash' }),
        probedAt: '2026-08-21T00:00:00.000Z',
        fullDirty: tier === 'fast',
      }),
    })
    const router = new Router()
    registerIntegrationRoutes(router, {
      store: { getWorkspace: () => ({ id: 'workspace-1' }) } as never,
      integrations: {
        getById: () => ({
          id: 'device-1',
          workspaceId: 'workspace-1',
          integrationId: 'builtin.ssh-device',
          displayName: '生产机',
          config: { host: '10.0.0.5', port: 22, username: 'root' },
          enabled: true,
          credentialConfigured: true,
          createdAt: '',
          updatedAt: '',
        }),
        secretsForConnection: () => ({ privateKey: 'key' }),
      } as never,
      environments: service,
    })
    const base = '/api/workspaces/workspace-1/integrations/builtin.ssh-device/connections/device-1/environment'

    const before = await call(router, 'GET', base)
    expect(before.status).toBe(200)
    expect(before.body.profile).toBeNull()

    const refreshed = await call(router, 'POST', `${base}/refresh`, {})
    expect(refreshed.status).toBe(200)
    expect((refreshed.body.profile as EnvironmentProfile).profileId).toBe('ssh:device-1')
    expect(service.profile('ssh:device-1')?.os).toBe('linux')

    const read = await call(router, 'GET', base)
    expect((read.body.profile as EnvironmentProfile).shell).toBe('bash')
  })
})
