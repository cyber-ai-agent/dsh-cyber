import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimePort, ConversationModelReadiness, ModelProfile } from '@dsh-cyber/contracts'
import { createCyberServer, type CyberServer } from '../src/index.js'
import { TurnAwareApprovalContinuationService } from '../src/services/turn-aware-approval-continuation-service.js'
import { ModelReadinessService, resolveModelCredential } from '../src/services/model-readiness-service.js'

const servers: CyberServer[] = []
const roots: string[] = []
beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', '') })
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const runtime: AgentRuntimePort = {
  async runTurn(request) { return { agentSessionId: `test-${request.agent.id}`, finalResponse: '收到。', eventCount: 0 } },
  async close() {},
}

async function start(options: { runtime?: AgentRuntimePort; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-readiness-'))
  if (options.root === undefined) roots.push(root)
  const server = await createCyberServer({ stateRoot: root, workspacePath: root, port: 0, bootstrapDefaultWorld: true,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    conversationTaskIntent: { async classify() { return undefined } },
  })
  servers.push(server)
  const { origin } = await server.start()
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  const inspect = async (body: Record<string, unknown> = {}) => call(origin, `/api/worlds/${world.id}/model-readiness`, { employeeIds: [employee.id], ...body })
  const saveProfile = (overrides: Partial<ModelProfile> = {}) => server.store.saveModelProfile({
    workspaceId: workspace.id, displayName: '本地模型', providerKind: 'openai-compatible-local',
    baseUrl: 'http://127.0.0.1:9/v1', modelId: 'test-model', api: 'openai-completions', ...overrides,
  })
  return { server, root, origin, workspace, world, employee, inspect, saveProfile }
}
async function call(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as any }
}

function item(value: { body: ConversationModelReadiness }) { return value.body.items[0]! }

describe('conversation model readiness', () => {
  it('rejects unconfigured first sends before attachments, messages, turns or classification are accepted', async () => {
    const f = await start()
    const state = await f.inspect()
    expect(state.status).toBe(200)
    expect(state.body.canSend).toBe(false)
    expect(item(state)).toMatchObject({ state: 'none', blockingReason: 'no-model' })
    const before = f.server.store.database.prepare('SELECT count(*) AS count FROM work_turns').get()
    const sent = await call(f.origin, `/api/worlds/${f.world.id}/chat`, {
      employeeIds: [f.employee.id], prompt: '你好', clientTurnId: 'first-send', attachments: [{ assetId: 'not-yet-readable' }],
    })
    expect(sent.status).toBe(422)
    expect(sent.body.error).toMatchObject({ code: 'model_setup_required', message: expect.stringContaining('模型中心') })
    expect(f.server.store.database.prepare('SELECT count(*) AS count FROM work_turns').get()).toEqual(before)
    expect(f.server.store.getConversationSubmissionClaim(f.workspace.id, f.world.id, 'first-send')).toBeUndefined()
  })

  it('uses actual first-profile, default and employee → world → workspace inheritance', async () => {
    const f = await start()
    const first = f.saveProfile({ id: 'first' })
    expect(item(await f.inspect())).toMatchObject({ modelProfileId: first.id, source: 'first-profile', state: 'configured-unverified', credentialSource: 'not-required' })
    const fallback = f.saveProfile({ id: 'default', isDefault: true })
    expect(item(await f.inspect())).toMatchObject({ modelProfileId: fallback.id, source: 'default' })
    for (const [scope, scopeId] of [['workspace', f.workspace.id], ['world', f.world.id], ['employee', f.employee.id]] as const) {
      const profile = f.saveProfile({ id: scope })
      f.server.store.saveModelAssignment({ workspaceId: f.workspace.id, scope, scopeId, modelProfileId: profile.id })
      expect(item(await f.inspect())).toMatchObject({ modelProfileId: profile.id, source: scope })
    }
    expect(item(await f.inspect({ modelProfileId: first.id }))).toMatchObject({ modelProfileId: first.id, source: 'temporary' })
  })

  it('resolves each group member independently and respects per-member temporary overrides', async () => {
    const f = await start()
    const second = f.server.store.recruitEmployee({ workspaceId: f.workspace.id, worldId: f.world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '第二位' })
    const firstModel = f.saveProfile({ id: 'group-first' })
    const missing = f.saveProfile({ id: 'group-missing', providerKind: 'openai-compatible-remote', baseUrl: 'https://example.test/v1' })
    f.server.store.saveModelAssignment({ workspaceId: f.workspace.id, scope: 'employee', scopeId: second.id, modelProfileId: missing.id })
    const group = { employeeIds: [f.employee.id, second.id], modelProfileId: firstModel.id }
    const mixed = await f.inspect(group)
    expect(mixed.body.canSend).toBe(false)
    expect(mixed.body.items).toMatchObject([{ employeeId: f.employee.id, modelProfileId: firstModel.id }, { employeeId: second.id, modelProfileId: missing.id, state: 'missing-credential' }])
    const overridden = await f.inspect({ ...group, modelProfileIds: { [second.id]: firstModel.id } })
    expect(overridden.body.canSend).toBe(true)
    expect(overridden.body.items[1]).toMatchObject({ source: 'temporary', modelProfileId: firstModel.id })
  })

  it('settles raw approval continuations before model preflight', async () => {
    const f = await start()
    const preflight = vi.spyOn(ModelReadinessService.prototype, 'assertCanSend')
    vi.spyOn(TurnAwareApprovalContinuationService.prototype, 'tryDecideWorldPermissionText').mockResolvedValue({
      handled: true, request: { id: 'original-approval' }, continuation: { workTurnId: 'original-turn', replies: [] },
    } as never)
    const sent = await call(f.origin, `/api/worlds/${f.world.id}/chat`, { employeeIds: [f.employee.id], prompt: '同意' })
    expect(sent.status).toBe(200)
    expect(sent.body.workTurnId).toBe('original-turn')
    expect(preflight).not.toHaveBeenCalled()
  })

  it('blocks missing credentials, including a declared but absent key on a local model', async () => {
    const f = await start()
    const profile = f.saveProfile({ credentialEnvName: 'CYBER_READINESS_ABSENT_API_KEY' })
    vi.stubEnv('CYBER_READINESS_ABSENT_API_KEY', '')
    expect(item(await f.inspect())).toMatchObject({ modelProfileId: profile.id, state: 'missing-credential', blockingReason: 'missing-credential' })
    const sent = await call(f.origin, `/api/worlds/${f.world.id}/chat`, { employeeIds: [f.employee.id], prompt: '你好' })
    expect(sent.body.error.code).toBe('model_setup_required')
    vi.stubEnv('CYBER_READINESS_ABSENT_API_KEY', 'test-environment-value')
    const configured = await f.inspect()
    expect(configured.body.canSend).toBe(true)
    expect(item(configured)).toMatchObject({ state: 'configured-unverified', credentialSource: 'environment' })
    expect(JSON.stringify(configured.body)).not.toContain('test-environment-value')
    expect(JSON.stringify(configured.body)).not.toContain('CYBER_READINESS_ABSENT_API_KEY')
  })

  it('resolves provider-owned credentials without requiring a profile-owned vault entry', async () => {
    const f = await start()
    const provider = await call(f.origin, `/api/workspaces/${f.workspace.id}/model-providers`, {
      name: '测试服务', baseUrl: 'https://example.test/v1', api: 'openai-completions', providerKind: 'openai-compatible-remote', apiKey: 'test-provider-secret',
    })
    expect(provider.status).toBe(200)
    f.saveProfile({ providerId: provider.body.provider.id, baseUrl: 'https://example.test/v1', providerKind: 'openai-compatible-remote' })
    const configured = await f.inspect()
    expect(item(configured)).toMatchObject({ state: 'configured-unverified', credentialSource: 'provider' })
    expect(JSON.stringify(configured.body)).not.toContain('test-provider-secret')
  })

  it('resolves legacy profile vault credentials and external DeepSeek environment credentials', async () => {
    const f = await start()
    const profile = await call(f.origin, `/api/workspaces/${f.workspace.id}/model-profiles`, {
      displayName: '旧配置', baseUrl: 'https://example.test/v1', api: 'openai-completions', modelId: 'legacy', providerKind: 'openai-compatible-remote', apiKey: 'test-profile-secret',
    })
    expect(profile.status).toBe(201)
    expect(item(await f.inspect())).toMatchObject({ state: 'configured-unverified', credentialSource: 'profile' })
    const deepseek = f.saveProfile({ providerKind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' })
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-deepseek-secret')
    const configured = await f.inspect({ modelProfileId: deepseek.id })
    expect(item(configured)).toMatchObject({ state: 'configured-unverified', credentialSource: 'environment' })
    expect(JSON.stringify(configured.body)).not.toContain('test-deepseek-secret')
  })

  it('keeps default Harness environment and isolated external settings available without claiming verification', async () => {
    const f = await start()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-default-secret')
    expect(item(await f.inspect())).toMatchObject({ source: 'harness-default', state: 'configured-unverified' })
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const home = join(f.root, 'runtime', 'providers', 'dsh-default', 'harness-home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'settings.yaml'), 'llm-deepseek:\n  apiKeyEnv: LOCAL_DEFAULT_KEY\n')
    expect(item(await f.inspect())).toMatchObject({ source: 'harness-default', state: 'missing-credential' })
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  LOCAL_DEFAULT_KEY: test-external-key\n', { mode: 0o600 })
    expect(item(await f.inspect())).toMatchObject({ source: 'harness-default', state: 'configured-unverified' })
    for (const empty of ['{}', 'llm: {}', 'llm-pi-ai: { providers: {} }', 'llm-deepseek: {}', 'llm: { model: deepseek-flash, provider: deepseek-official }', 'llm-pi-ai: { providers: { other: { baseURL: http://localhost:9, models: [other] } } }']) {
      await writeFile(join(home, 'settings.yaml'), empty)
      expect(item(await f.inspect()).state).toBe('none')
    }
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: test-worker-only-key\n', { mode: 0o600 })
    const stored = await f.inspect()
    expect(item(stored).state).toBe('configured-unverified')
    expect(JSON.stringify(stored.body)).not.toContain('test-worker-only-key')
  })

  it('recognizes only the current worker home and role workspace .env credentials without loading their values into process.env', async () => {
    const f = await start()
    const home = join(f.root, 'runtime', 'providers', 'dsh-default', 'harness-home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.env'), 'DEEPSEEK_API_KEY="test-worker-dotenv"\n')
    expect(item(await f.inspect())).toMatchObject({ state: 'configured-unverified', source: 'harness-default' })
    expect(process.env.DEEPSEEK_API_KEY).toBe('')
    await writeFile(join(home, '.env'), 'UNRELATED_KEY=test-unrelated\n')
    expect(item(await f.inspect()).state).toBe('none')
    const files = join(f.root, 'worlds', f.world.id, 'files')
    await mkdir(files, { recursive: true })
    await writeFile(join(files, '.env'), 'DEEPSEEK_API_KEY=test-project-dotenv\nREADINESS_PROFILE_API_KEY=test-profile-dotenv\n')
    expect(item(await f.inspect()).state).toBe('configured-unverified')
    const profile = f.saveProfile({ providerKind: 'openai-compatible-remote', baseUrl: 'https://example.test/v1', credentialEnvName: 'READINESS_PROFILE_API_KEY' })
    const configured = await f.inspect()
    expect(item(configured)).toMatchObject({ state: 'configured-unverified', credentialSource: 'environment' })
    expect(JSON.stringify(configured.body)).not.toContain('test-profile-dotenv')
    expect(process.env.READINESS_PROFILE_API_KEY).toBeUndefined()
    f.saveProfile({ ...profile, settings: { imageGeneration: true } })
    expect(item(await f.inspect()).state).toBe('missing-credential')
  })

  it('rejects unknown or foreign models, unrelated members and per-member map entries', async () => {
    const f = await start()
    expect((await f.inspect({ modelProfileId: 'missing' })).status).toBe(422)
    expect((await f.inspect({ employeeIds: ['missing'] })).status).toBe(422)
    const other = f.server.store.createWorkspace({ name: 'other' })
    const foreign = f.saveProfile({ workspaceId: other.id })
    expect((await f.inspect({ modelProfileId: foreign.id })).status).toBe(422)
    const local = f.saveProfile()
    expect((await f.inspect({ modelProfileIds: { outsider: local.id } })).status).toBe(422)
  })

  it('keeps injected runtime adapters usable without pretending their model was verified', async () => {
    const f = await start({ runtime })
    expect(item(await f.inspect())).toMatchObject({ source: 'external-runtime', state: 'configured-unverified' })
    expect((await f.inspect()).body.canSend).toBe(true)
    const sent = await call(f.origin, `/api/worlds/${f.world.id}/chat`, { employeeIds: [f.employee.id], prompt: '你好', clientTurnId: 'accepted' })
    expect(sent.status).toBe(200)
    expect(sent.body.replies).toHaveLength(1)
  })

  it('replays an accepted idempotent request after restart even when model setup is now missing', async () => {
    const f = await start({ runtime })
    const request = { employeeIds: [f.employee.id], prompt: '你好', clientTurnId: 'accepted-before-restart' }
    const sent = await call(f.origin, `/api/worlds/${f.world.id}/chat`, request)
    expect(sent.status).toBe(200)
    await f.server.close()
    servers.splice(servers.indexOf(f.server), 1)
    const restarted = await start({ root: f.root })
    expect((await restarted.inspect()).body.canSend).toBe(false)
    const replay = await call(restarted.origin, `/api/worlds/${f.world.id}/chat`, request)
    expect(replay.status).toBe(200)
    expect(replay.body.workTurnId).toBe(sent.body.workTurnId)
    expect(restarted.server.store.database.prepare('SELECT count(*) AS count FROM work_turns').get()).toEqual({ count: 1 })
    const conflict = await call(restarted.origin, `/api/worlds/${f.world.id}/chat`, { ...request, prompt: '不同请求' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('client_turn_conflict')
  })
})

describe('runtime credential authority', () => {
  const profile = { id: 'profile', workspaceId: 'workspace', providerId: 'provider', providerKind: 'openai-compatible-remote', baseUrl: 'https://example.test/v1' } as ModelProfile
  it('returns the actual provider environment reference used by the Harness', () => {
    const result = resolveModelCredential({ getModelProvider: () => ({ id: 'provider', workspaceId: 'workspace', baseUrl: profile.baseUrl, credentialEnvName: 'TEST_API_KEY' }) as any }, { resolve: () => undefined, credentialEnvName: (id) => id }, profile, { TEST_API_KEY: 'not-real' })
    expect(result).toEqual({ credentialEnvName: 'TEST_API_KEY', source: 'provider', configured: true })
  })
  it('uses an implicit DeepSeek environment key only for the official HTTPS origin', () => {
    const dependencies = { getModelProvider: () => undefined }
    const credentials = { resolve: () => undefined, credentialEnvName: (id: string) => id }
    const environment = { DEEPSEEK_API_KEY: 'ambient-secret' }
    for (const baseUrl of ['https://other.example/v1', 'https://api.deepseek.com.evil.test/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1']) {
      expect(resolveModelCredential(dependencies, credentials, { ...profile, providerKind: 'deepseek', baseUrl }, environment)).toEqual({ source: 'none', configured: false })
    }
    expect(resolveModelCredential(dependencies, credentials, { ...profile, providerKind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }, environment)).toEqual({ source: 'environment', configured: true, credentialEnvName: 'DEEPSEEK_API_KEY' })
  })
  it('does not replace a named but missing profile credential with a provider or stale profile key', () => {
    const result = resolveModelCredential({ getModelProvider: () => ({ id: 'provider', workspaceId: 'workspace', baseUrl: profile.baseUrl, credentialEnvName: 'PROVIDER_API_KEY' }) as any }, {
      resolve: () => 'still-configured-secret', credentialEnvName: (id) => `MANAGED_${id}`,
    }, { ...profile, credentialEnvName: 'REQUIRED_API_KEY' }, { PROVIDER_API_KEY: 'not-real' })
    expect(result).toEqual({ credentialEnvName: 'REQUIRED_API_KEY', source: 'none', configured: false })
  })
  it('does not borrow a credential from another workspace or a different provider endpoint', () => {
    for (const provider of [{ workspaceId: 'other', baseUrl: profile.baseUrl }, { workspaceId: 'workspace', baseUrl: 'https://other.test/v1' }]) {
      const result = resolveModelCredential({ getModelProvider: () => ({ id: 'provider', ...provider, credentialEnvName: 'TEST_API_KEY' }) as any }, { resolve: (id) => id === 'provider' ? 'not-real' : undefined, credentialEnvName: (id) => id }, profile, { TEST_API_KEY: 'not-real' })
      expect(result).toEqual({ source: 'none', configured: false })
    }
  })
})
