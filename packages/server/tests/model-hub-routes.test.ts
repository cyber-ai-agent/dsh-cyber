import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { AgentRuntimePort } from '@dsh-cyber/contracts'
import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

beforeAll(() => {
  // Offline deterministic catalog: the bundled snapshot, never the network.
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function startServer(): Promise<CyberServer & { origin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-routes-'))
  roots.push(root)
  const server = await createCyberServer({
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: new SilentRuntime(),
    stateRoot: root,
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin })
}

class SilentRuntime implements AgentRuntimePort {
  async runTurn(request: Record<string, unknown>) {
    return { agentSessionId: `hub-${String(request.agent?.id ?? 'x')}`, finalResponse: '好的。', eventCount: 0 }
  }

  async close() {}
}

async function call(origin: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    // The JSON guard applies to every state-changing method, body or not.
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> }
}

describe('model hub routes', () => {
  it('serves the bundled catalog offline with signup guidance', async () => {
    const { origin } = await startServer()
    const state = await call(origin, 'GET', '/api/model-provider-catalog')
    expect(state.status).toBe(200)
    expect(state.body.source).toBe('bundled')
    const deepseek = state.body.catalog.providers.find((entry: { id: string }) => entry.id === 'deepseek')
    expect(deepseek.signup.url).toContain('https://platform.deepseek.com')
    expect(deepseek.balance).toBe('deepseek')
  })

  it('creates a provider, imports models idempotently and guards deletion while assigned', async () => {
    const server = await startServer()
    const { origin } = server
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!

    const created = await call(origin, 'POST', `/api/workspaces/${workspace.id}/model-providers`, {
      name: '本地推理机',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      providerKind: 'openai-compatible-local',
      credentialMode: 'none',
    })
    expect(created.status).toBe(200)
    expect(created.body.provider.kind).toBe('local')
    const providerId = created.body.provider.id as string

    const imported = await call(origin, 'POST', `/api/workspaces/${workspace.id}/model-providers/${providerId}/import`, {
      models: [{ id: 'qwen-9b', displayName: '本地 Qwen', contextLength: 32_768 }, { id: 'tiny' }],
    })
    expect(imported.status).toBe(200)
    expect(imported.body.created).toBe(2)
    const qwen = imported.body.profiles.find((profile: { modelId: string }) => profile.modelId === 'qwen-9b')
    expect(qwen).toMatchObject({ origin: 'imported', providerId, displayName: '本地 Qwen' })
    expect(qwen.settings.contextWindow).toBe(32_768)

    // Re-import updates in place — no duplicate rows.
    const again = await call(origin, 'POST', `/api/workspaces/${workspace.id}/model-providers/${providerId}/import`, {
      models: [{ id: 'qwen-9b', displayName: '改名 Qwen', contextLength: 16_384 }],
    })
    expect(again.body.created).toBe(0)
    expect(again.body.updated).toBe(1)
    const profiles = server.store.listProviderProfiles(providerId)
    expect(profiles.filter((profile) => profile.modelId === 'qwen-9b')).toHaveLength(1)
    expect(profiles.find((profile) => profile.modelId === 'qwen-9b')?.settings.contextWindow).toBe(16_384)

    // Assigning a pool model blocks provider deletion.
    await call(origin, 'PUT', `/api/workspaces/${workspace.id}/model-assignments/world/${world.id}`, { modelProfileId: qwen.id })
    const blocked = await call(origin, 'DELETE', `/api/workspaces/${workspace.id}/model-providers/${providerId}`)
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toContain('分配')

    await call(origin, 'DELETE', `/api/workspaces/${workspace.id}/model-assignments/world/${world.id}`)
    const removed = await call(origin, 'DELETE', `/api/workspaces/${workspace.id}/model-providers/${providerId}`)
    expect(removed.status).toBe(200)
    expect(server.store.listProviderProfiles(providerId)).toEqual([])
  })

  it('rejects remote HTTP endpoints for remote provider kinds', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const bad = await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-providers`, {
      name: '公网走 HTTP',
      baseUrl: 'http://models.example.com/v1',
      api: 'openai-completions',
      providerKind: 'openai-compatible-remote',
    })
    expect(bad.status).toBe(422)
  })

  it('probes capabilities, persists only verdicts and enforces the cooldown', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const provider = (await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-providers`, {
      name: '本地推理机',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      providerKind: 'openai-compatible-local',
    })).body.provider
    await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-providers/${provider.id}/import`, {
      models: [{ id: 'qwen' }],
    })
    const profile = server.store.listProviderProfiles(provider.id)[0]!

    const probed = await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-profiles/${profile.id}/probe`)
    expect(probed.status).toBe(200)
    // Unreachable endpoint says 'error', never a false 'unsupported'.
    expect(probed.body.capabilities).toEqual({ tools: 'error', json: 'error' })
    expect(server.store.getModelProfile(profile.id)?.probedAt).toBeTypeOf('string')

    const cooled = await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-profiles/${profile.id}/probe`)
    expect(cooled.status).toBe(429)
  })

  it('reports balance support from the catalog and refuses without a credential', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const provider = (await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-providers`, {
      name: 'DeepSeek',
      catalogRef: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      providerKind: 'deepseek',
    })).body.provider
    const list = await call(server.origin, 'GET', `/api/workspaces/${workspace.id}/model-providers`)
    expect(list.body.items[0]).toMatchObject({ kind: 'builtin', balanceSupported: true })
    expect(list.body.items[0].signup.url).toContain('platform.deepseek.com')
    const balance = await call(server.origin, 'POST', `/api/workspaces/${workspace.id}/model-providers/${provider.id}/balance`)
    expect(balance.status).toBe(422)
    expect(balance.body.error.code ?? JSON.stringify(balance.body)).toContain('credential')
  })
})
