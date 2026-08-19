import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

class FakeRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    const content = request.agent.role === '软件工程师'
      ? '我先建立性能基线。'
      : `我已看到前序发言，并从${request.agent.role}角度补充。`
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    request.onEvent?.({
      kind: 'turn.started',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      sourceSequence: 1,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'assistant.reasoning',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      sourceSequence: 2,
      content: '核对事实与权限。',
      metadata: {},
    })
    request.onEvent?.({
      kind: 'tool.started',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      sourceSequence: 3,
      toolName: 'search_workspace',
      callId: `call-${request.agent.id}`,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'tool.completed',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      sourceSequence: 4,
      callId: `call-${request.agent.id}`,
      failed: false,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'assistant.message',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      sourceSequence: 5,
      content,
      metadata: {},
    })
    request.onEvent?.({
      kind: 'turn.completed',
      source: 'test-runtime',
      sourceSessionId: agentSessionId,
      sourceSequence: 6,
      metadata: {},
    })
    return { agentSessionId, finalResponse: content, eventCount: 6 }
  }

  async close(): Promise<void> {}
}

async function start(stateRoot: string, runtime = new FakeRuntime(), webRoot?: string) {
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    ...(webRoot === undefined ? {} : { webRoot }),
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
    body: JSON.stringify({ name: '本地工作区' }),
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
  expect(result.response.status).toBe(201)
  return result.body.employee as { id: string; displayName: string }
}

describe('Cyber local server', () => {
  it('starts loopback-only with an empty world and independent role catalogs', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const { origin } = await start(stateRoot)

    const workspaces = await json(origin, '/api/workspaces')
    expect(workspaces.body.items).toEqual([])
    const templates = await json(origin, '/api/catalog/world-templates')
    expect(templates.body.items.map((item: { id: string }) => item.id)).toEqual([
      'cyber-company',
      'tavern',
      'creator-studio',
    ])
    const { workspace, world } = await createWorld(origin)
    const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
    expect(snapshot.body.employees).toEqual([])
    expect(snapshot.body.world.workspaceId).toBe(workspace.id)

    const companyCatalog = await json(origin, '/api/catalog/blueprints?templateId=cyber-company')
    const tavernCatalog = await json(origin, '/api/catalog/blueprints?templateId=tavern')
    expect(companyCatalog.body.items.every((item: { worldTemplateId: string }) => item.worldTemplateId === 'cyber-company')).toBe(true)
    expect(tavernCatalog.body.items.every((item: { worldTemplateId: string }) => item.worldTemplateId === 'tavern')).toBe(true)
  })

  it('previews package permissions, requires exact approval, and preserves the active version on failure', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const { origin } = await start(stateRoot)
    const { workspace } = await createWorld(origin)
    const sourceV1 = join(stateRoot, 'package-source-v1')
    const sourceV2 = join(stateRoot, 'package-source-v2')
    await mkdir(sourceV1, { recursive: true })
    await mkdir(sourceV2, { recursive: true })
    await writeFile(join(sourceV1, 'SKILL.md'), '# V1\n', 'utf8')
    await writeFile(join(sourceV2, 'SKILL.md'), '# tampered\n', 'utf8')
    const packageManifest = {
      schemaVersion: 1,
      id: '@cyber/local-skill',
      version: '1.0.0',
      kind: 'skill',
      displayName: '本地技能',
      summary: '测试最小权限安装。',
      license: 'PolyForm-Noncommercial-1.0.0',
      publisher: 'Local',
      capabilities: ['workspace:read'],
      dataEgress: [],
      files: [
        {
          path: 'SKILL.md',
          sha256: createHash('sha256').update('# V1\n').digest('hex'),
        },
      ],
    }
    const preview = await json(origin, `/api/workspaces/${workspace.id}/packages/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: packageManifest }),
    })
    expect(preview.response.status).toBe(200)
    expect(preview.body.addedCapabilities).toEqual(['workspace:read'])

    const staleApproval = await json(origin, `/api/workspaces/${workspace.id}/packages/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: packageManifest,
        sourceDirectory: sourceV1,
        approvalToken: 'stale',
      }),
    })
    expect(staleApproval.response.status).toBe(409)

    const installed = await json(origin, `/api/workspaces/${workspace.id}/packages/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: packageManifest,
        sourceDirectory: sourceV1,
        approvalToken: preview.body.approvalToken,
      }),
    })
    expect(installed.response.status).toBe(201)
    expect(installed.body.installed).toMatchObject({ version: '1.0.0', status: 'active' })

    const brokenV2 = {
      ...packageManifest,
      version: '2.0.0',
      capabilities: ['workspace:read', 'workspace:write'],
      files: [{ path: 'SKILL.md', sha256: packageManifest.files[0]!.sha256 }],
    }
    const v2Preview = await json(origin, `/api/workspaces/${workspace.id}/packages/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: brokenV2 }),
    })
    const failedUpgrade = await json(origin, `/api/workspaces/${workspace.id}/packages/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: brokenV2,
        sourceDirectory: sourceV2,
        approvalToken: v2Preview.body.approvalToken,
      }),
    })
    expect(failedUpgrade.response.status).toBe(422)

    const packages = await json(origin, `/api/workspaces/${workspace.id}/packages`)
    expect(packages.body.items).toHaveLength(1)
    expect(packages.body.items[0]).toMatchObject({ version: '1.0.0', status: 'active' })
    expect(packages.body.transactions[0]).toMatchObject({
      version: '2.0.0',
      status: 'rolled-back',
    })
  })

  it('resolves @ mentions to two real agents, persists their own sessions, and survives restart', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const firstRuntime = new FakeRuntime()
    const first = await start(stateRoot, firstRuntime)
    const { workspace, world } = await createWorld(first.origin)
    const engineer = await recruit(
      first.origin,
      world.id,
      'cyber-company.software-engineer',
    )
    const archivist = await recruit(first.origin, world.id, 'cyber-company.archivist')
    const stream = openRuntimeStream(first.origin, world.id)
    await stream.ready

    const chat = await json(first.origin, `/api/worlds/${world.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `@${engineer.displayName} @${archivist.displayName} 讨论登录性能与历史证据`,
      }),
    })
    expect(chat.response.status).toBe(200)
    expect(chat.body.replies).toHaveLength(2)
    expect(firstRuntime.calls).toHaveLength(2)
    expect(firstRuntime.calls[0]?.agent.id).toBe(engineer.id)
    expect(firstRuntime.calls[1]?.agent.id).toBe(archivist.id)
    expect(firstRuntime.calls[1]?.prompt).toContain('开发工程师：我先建立性能基线。')
    const sessionId = chat.body.session.id as string
    const runtimeEvents = await stream.waitForCount(12)
    stream.close()
    expect(runtimeEvents.map((item) => item.event.kind)).toEqual([
      'turn.started', 'assistant.reasoning', 'tool.started', 'tool.completed', 'assistant.message', 'turn.completed',
      'turn.started', 'assistant.reasoning', 'tool.started', 'tool.completed', 'assistant.message', 'turn.completed',
    ])

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await start(stateRoot, new FakeRuntime())
    const workspaceSnapshot = await json(second.origin, `/api/workspaces/${workspace.id}/snapshot`)
    const worldSnapshot = await json(second.origin, `/api/worlds/${world.id}/snapshot`)
    const messages = await json(second.origin, `/api/sessions/${sessionId}/messages`)
    expect(workspaceSnapshot.body.worlds).toHaveLength(1)
    expect(worldSnapshot.body.employees).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'assistant')).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'reasoning')).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'tool-call')).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'tool-result')).toHaveLength(2)
    expect(worldSnapshot.body.employees.every((item: { agentSessionId?: string }) => item.agentSessionId)).toBe(true)
  })

  it('starts a world-scoped conversation after a theme switch and never leaks old @ roles', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const runtime = new FakeRuntime()
    const { origin } = await start(stateRoot, runtime)
    const { workspace, world: company } = await createWorld(origin)
    const tavernResult = await json(origin, `/api/workspaces/${workspace.id}/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '月影酒馆', templateId: 'tavern' }),
    })
    const tavern = tavernResult.body.world as { id: string }
    const engineer = await recruit(origin, company.id, 'cyber-company.software-engineer')
    const innkeeper = await recruit(origin, tavern.id, 'tavern.innkeeper')

    const companyChat = await json(origin, `/api/worlds/${company.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [engineer.id], prompt: `@${engineer.displayName} 建立基线` }),
    })
    expect(companyChat.response.status).toBe(200)
    const companySessionId = companyChat.body.session.id as string

    const leakedMention = await json(origin, `/api/worlds/${tavern.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: `@${engineer.displayName} 你还在吗` }),
    })
    expect(leakedMention.response.status).toBe(422)
    expect(leakedMention.body.error.code).toBe('agent_required')
    expect(runtime.calls).toHaveLength(1)

    const leakedSession = await json(origin, `/api/worlds/${tavern.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeIds: [innkeeper.id],
        sessionId: companySessionId,
        prompt: `@${innkeeper.displayName} 开门营业`,
      }),
    })
    expect(leakedSession.response.status).toBe(422)
    expect(leakedSession.body.error.code).toBe('conversation_rejected')
    expect(runtime.calls).toHaveLength(1)

    const tavernChat = await json(origin, `/api/worlds/${tavern.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [innkeeper.id], prompt: `@${innkeeper.displayName} 开门营业` }),
    })
    expect(tavernChat.response.status).toBe(200)
    expect(tavernChat.body.session.worldId).toBe(tavern.id)
    expect(tavernChat.body.session.id).not.toBe(companySessionId)

    const companySessions = await json(origin, `/api/worlds/${company.id}/sessions`)
    const tavernSessions = await json(origin, `/api/worlds/${tavern.id}/sessions`)
    expect(companySessions.body.items).toHaveLength(1)
    expect(tavernSessions.body.items).toHaveLength(1)
    expect(tavernSessions.body.items[0].worldId).toBe(tavern.id)
  })

  it('serves the standalone shell and persists appearance, model, asset, and employee dossier settings', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const webRoot = join(stateRoot, 'web')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root">DSH Cyber</div>', 'utf8')
    await writeFile(join(webRoot, 'assets', 'app-12345678.js'), 'globalThis.cyber=true', 'utf8')
    const { origin } = await start(stateRoot, new FakeRuntime(), webRoot)

    const shell = await fetch(origin)
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('DSH Cyber')
    expect(shell.headers.get('content-security-policy')).toContain("script-src 'self'")

    const { workspace, world } = await createWorld(origin)
    const employee = await recruit(origin, world.id, 'cyber-company.software-engineer')
    const profile = await json(origin, `/api/employees/${employee.id}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: '阿帆',
        birthday: '05-24',
        background: '负责可验证的软件交付。',
        personalityTraits: ['严谨', '主动'],
        appearance: { avatarIndex: 6 },
        reason: '完善员工数字档案',
      }),
    })
    expect(profile.response.status).toBe(201)

    const preferences = await json(origin, `/api/workspaces/${workspace.id}/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        colorScheme: 'light',
        skinId: 'paper-daylight',
        backgroundFit: 'contain',
        backgroundOpacity: 0.24,
        interfaceDensity: 'comfortable',
        motion: 'reduced',
        leftPaneWidth: 318,
        rightPaneWidth: 544,
      }),
    })
    expect(preferences.body.preferences).toMatchObject({
      colorScheme: 'light',
      skinId: 'paper-daylight',
      leftPaneWidth: 318,
      rightPaneWidth: 544,
    })

    const model = await json(origin, `/api/workspaces/${workspace.id}/model-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: '本地 Qwen',
        providerKind: 'openai-compatible-local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:14b',
        api: 'openai-completions',
        credentialEnvName: 'LOCAL_MODEL_API_KEY',
        isDefault: true,
        settings: {},
      }),
    })
    expect(model.response.status).toBe(201)
    expect(model.body.profile).not.toHaveProperty('credential')
    expect(model.body.profile.credentialEnvName).toBe('LOCAL_MODEL_API_KEY')

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const asset = await json(origin, `/api/workspaces/${workspace.id}/assets/background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType: 'image/png', dataBase64: pngBase64 }),
    })
    expect(asset.response.status).toBe(201)
    const downloaded = await fetch(`${origin}${asset.body.url}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('image/png')

    const status = await json(origin, '/api/system/status')
    expect(status.response.status).toBe(200)
    expect(status.body).toMatchObject({ ok: true, database: { ok: true }, compatibility: { ok: true } })
    const doctor = await json(origin, '/api/system/doctor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(doctor.body).toMatchObject({ ok: true, database: { integrity: ['ok'] } })
    const backup = await json(origin, '/api/system/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const exported = await json(origin, '/api/system/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect((await stat(backup.body.output)).isFile()).toBe(true)
    expect((await stat(exported.body.output)).isFile()).toBe(true)

    const dossier = await json(origin, `/api/employees/${employee.id}/dossier`)
    expect(dossier.body.profile).toMatchObject({ birthday: '05-24', personalityTraits: ['严谨', '主动'] })
    expect(dossier.body.profile.appearance).toMatchObject({ avatarIndex: 6 })
    expect(dossier.body.employee.displayName).toBe('阿帆')
    expect(dossier.body.milestones[0]).toMatchObject({ category: 'joined' })
  })

  it('browses and previews safe workspace files without exposing hidden files or traversal', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-files-'))
    await mkdir(join(stateRoot, 'src'), { recursive: true })
    await writeFile(join(stateRoot, 'src', 'hello.ts'), 'export const hello = "cyber"\n', 'utf8')
    await writeFile(join(stateRoot, '.env'), 'SECRET_MUST_NOT_LEAK=value\n', 'utf8')
    const { origin } = await start(stateRoot)

    const root = await json(origin, '/api/workspace/files')
    expect(root.response.status).toBe(200)
    expect(root.body.items.map((item: { name: string }) => item.name)).toContain('src')
    expect(root.body.items.map((item: { name: string }) => item.name)).not.toContain('.env')

    const nested = await json(origin, '/api/workspace/files?path=src')
    expect(nested.body).toMatchObject({ path: 'src', parentPath: '' })
    expect(nested.body.items).toEqual([
      expect.objectContaining({ name: 'hello.ts', kind: 'file', previewKind: 'text' }),
    ])
    const preview = await fetch(`${origin}/api/workspace/file?path=src%2Fhello.ts`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toContain('text/plain')
    expect(await preview.text()).toContain('export const hello')

    const hidden = await fetch(`${origin}/api/workspace/file?path=.env`)
    expect(hidden.status).toBe(403)
    const traversal = await fetch(`${origin}/api/workspace/files?path=..%2F`)
    expect(traversal.status).toBe(403)
  })

  it('rejects DNS rebinding and cross-origin mutation requests', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const { origin } = await start(stateRoot)
    const address = new URL(origin)

    const hostStatus = await rawStatus(Number(address.port), {
      method: 'GET',
      path: '/api/health',
      headers: { Host: 'evil.example' },
    })
    expect(hostStatus).toBe(403)

    const originStatus = await rawStatus(Number(address.port), {
      method: 'POST',
      path: '/api/workspaces',
      headers: {
        Host: address.host,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ name: 'blocked' }),
    })
    expect(originStatus).toBe(403)
  })
})

function rawStatus(
  port: number,
  options: { method: string; path: string; headers: Record<string, string>; body?: string },
): Promise<number | undefined> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        response.resume()
        response.once('end', () => resolvePromise(response.statusCode))
      },
    )
    request.once('error', reject)
    request.end(options.body)
  })
}

function openRuntimeStream(origin: string, worldId: string): {
  ready: Promise<void>
  waitForCount(count: number): Promise<any[]>
  close(): void
} {
  const target = new URL(origin)
  const runtimeEvents: any[] = []
  const waiters: Array<{ count: number; resolve(items: any[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = []
  let buffer = ''
  let request: ReturnType<typeof httpRequest>
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolvePromise, reject) => {
    resolveReady = resolvePromise
    rejectReady = reject
  })
  request = httpRequest({
    hostname: '127.0.0.1',
    port: Number(target.port),
    method: 'GET',
    path: `/api/worlds/${encodeURIComponent(worldId)}/live`,
    headers: { Host: target.host },
  }, (response) => {
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const eventName = /^event:\s*(.+)$/m.exec(block)?.[1]
        const data = /^data:\s*(.+)$/m.exec(block)?.[1]
        if (eventName === 'ready') resolveReady()
        if (eventName === 'runtime' && data !== undefined) runtimeEvents.push(JSON.parse(data))
        for (const waiter of [...waiters]) {
          if (runtimeEvents.length < waiter.count) continue
          clearTimeout(waiter.timer)
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve([...runtimeEvents])
        }
        boundary = buffer.indexOf('\n\n')
      }
    })
  })
  request.once('error', (error) => {
    rejectReady(error)
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  })
  request.end()
  return {
    ready,
    waitForCount(count) {
      if (runtimeEvents.length >= count) return Promise.resolve([...runtimeEvents])
      return new Promise((resolvePromise, reject) => {
        const waiter = {
          count,
          resolve: resolvePromise,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1)
            reject(new Error(`Timed out waiting for ${count} runtime events; received ${runtimeEvents.length}`))
          }, 2_000),
        }
        waiters.push(waiter)
      })
    },
    close() { request.destroy() },
  }
}
