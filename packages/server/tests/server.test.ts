import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

async function start(
  stateRoot: string,
  runtime = new FakeRuntime(),
  webRoot?: string,
  marketplaceRoot?: string,
) {
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    ...(webRoot === undefined ? {} : { webRoot }),
    ...(marketplaceRoot === undefined ? {} : { marketplaceRoot }),
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

    const approvedRecruit = await json(origin, `/api/worlds/${world.id}/recruit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blueprintId: 'cyber-company.software-engineer',
        blueprintVersion: 1,
        capabilityGrants: ['workspace:read'],
      }),
    })
    expect(approvedRecruit.response.status).toBe(201)
    const dossier = await json(origin, `/api/employees/${approvedRecruit.body.employee.id}/dossier`)
    expect(dossier.body.revisions[0].capabilityGrants).toEqual(['workspace:read'])

    const rejectedRecruit = await json(origin, `/api/worlds/${world.id}/recruit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blueprintId: 'cyber-company.software-engineer',
        blueprintVersion: 1,
        capabilityGrants: ['workspace:write'],
      }),
    })
    expect(rejectedRecruit.response.status).toBe(422)
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

    const invalidPluginSource = join(stateRoot, 'invalid-plugin-source')
    await mkdir(invalidPluginSource, { recursive: true })
    const invalidPluginEntrypoint = `${JSON.stringify({
      schemaVersion: 1,
      transforms: [{
        id: 'unsafe-mode',
        trigger: 'always',
        description: 'Invalid staged entrypoint.',
        instruction: 'This package must never activate.',
        mode: 'execute',
      }],
    })}\n`
    await writeFile(join(invalidPluginSource, 'transforms.json'), invalidPluginEntrypoint, 'utf8')
    const invalidPluginManifest = {
      ...packageManifest,
      id: '@cyber/invalid-plugin',
      kind: 'plugin',
      capabilities: ['prompt:transform'],
      files: [{
        path: 'transforms.json',
        sha256: createHash('sha256').update(invalidPluginEntrypoint).digest('hex'),
      }],
      entrypoints: [{ id: 'transforms', kind: 'prompt-transform', path: 'transforms.json' }],
    }
    const invalidPluginPreview = await json(origin, `/api/workspaces/${workspace.id}/packages/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: invalidPluginManifest }),
    })
    const invalidPluginInstall = await json(origin, `/api/workspaces/${workspace.id}/packages/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: invalidPluginManifest,
        sourceDirectory: invalidPluginSource,
        approvalToken: invalidPluginPreview.body.approvalToken,
      }),
    })
    expect(invalidPluginInstall.response.status).toBe(422)

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

  it('projects, persists, interacts with, and recovers the World Runtime V2 state', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-runtime-'))
    const first = await start(stateRoot, new FakeRuntime())
    const { world } = await createWorld(first.origin)
    const engineer = await recruit(first.origin, world.id, 'cyber-company.software-engineer')
    const archivist = await recruit(first.origin, world.id, 'cyber-company.archivist')

    const projected = await json(first.origin, `/api/worlds/${world.id}/runtime-snapshot`)
    expect(projected.response.status).toBe(200)
    expect(projected.body).toMatchObject({
      contractVersion: 1,
      worldId: world.id,
      themeId: 'dsh-cyber.company.nocturne',
      sceneId: 'headquarters',
      clock: { lightsOn: true },
    })
    expect(projected.body.entities.map((item: { id: string }) => item.id).sort()).toEqual(
      [engineer.id, archivist.id].sort(),
    )
    expect(projected.body.objects).toHaveLength(4)

    const taskIntent = await json(first.origin, `/api/worlds/${world.id}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'assign-task',
        actorId: 'owner',
        entityId: engineer.id,
        objectId: 'workstation',
      }),
    })
    expect(taskIntent.body.status).toBe('pending')
    expect(taskIntent.body.snapshot.entities.find((item: { id: string }) => item.id === engineer.id).activity).toBe('idle')
    const meetingIntent = await json(first.origin, `/api/worlds/${world.id}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start-meeting', actorId: 'owner', participantIds: [engineer.id, archivist.id] }),
    })
    expect(meetingIntent.body.status).toBe('pending')
    const intentEvents = first.server.store.listWorldDomainEvents(world.id).map((event) => event.type)
    expect(intentEvents).not.toContain('task.started')
    expect(intentEvents).not.toContain('meeting.started')

    const objectInteraction = await json(first.origin, `/api/worlds/${world.id}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'use-object',
        actorId: 'owner',
        entityId: engineer.id,
        objectId: 'ops-console',
      }),
    })
    expect(objectInteraction.response.status).toBe(202)
    expect(objectInteraction.body.snapshot.objects).toContainEqual(
      expect.objectContaining({ id: 'ops-console', state: 'active' }),
    )

    const lights = await json(first.origin, `/api/worlds/${world.id}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle-lights', actorId: 'owner' }),
    })
    expect(lights.body.snapshot.clock.lightsOn).toBe(false)
    expect(first.server.store.doctor().counts).toMatchObject({
      worldRuntimeSnapshots: 1,
      worldEntityStates: 2,
      worldObjectStates: 4,
      worldThemeBindings: 0,
    })

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)
    const second = await start(stateRoot, new FakeRuntime())
    const recovered = await json(second.origin, `/api/worlds/${world.id}/runtime-snapshot`)
    expect(recovered.body.clock.lightsOn).toBe(false)
    expect(recovered.body.entities).toHaveLength(2)
    expect(recovered.body.sequence).toBeGreaterThan(projected.body.sequence)
  })

  it('resumes the world SSE stream with numeric sequence ids and no duplicate replay', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-sse-'))
    const { origin } = await start(stateRoot, new FakeRuntime())
    const { world } = await createWorld(origin)
    const employee = await recruit(origin, world.id, 'cyber-company.software-engineer')
    const initial = await json(origin, `/api/worlds/${world.id}/runtime-snapshot`)

    const live = openWorldStream(origin, world.id, initial.body.sequence)
    await live.connected
    await live.waitFor((event) => event.event === 'ready')
    await json(origin, `/api/worlds/${world.id}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle-lights', actorId: 'owner' }),
    })
    const changed = await live.waitFor((event) => event.event === 'world-state' && event.data.sequence > initial.body.sequence)
    expect(changed.id).toMatch(/^\d+$/)
    const lastSequence = Number(changed.id)
    live.close()

    const resumed = openWorldStream(origin, world.id, 0, String(lastSequence))
    await resumed.connected
    await resumed.waitFor((event) => event.event === 'ready')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
    expect(resumed.events.filter((event) => event.event === 'world-state')).toHaveLength(0)
    resumed.close()

    const stale = openWorldStream(origin, world.id, initial.body.sequence)
    await stale.connected
    const recovery = await stale.waitFor((event) => event.event === 'recovery-required')
    const recoveredState = await stale.waitFor((event) => event.event === 'world-state')
    expect(recovery.id).toBe(String(lastSequence))
    expect(recoveredState.id).toBe(String(lastSequence))
    expect(stale.events.filter((event) => event.event === 'world-state')).toHaveLength(1)
    stale.close()

    const boundarySnapshot = await json(origin, `/api/worlds/${world.id}/runtime-snapshot`)
    const boundary = openWorldStream(origin, world.id, boundarySnapshot.body.sequence)
    await boundary.connected
    await boundary.waitFor((event) => event.event === 'ready')
    await json(origin, `/api/worlds/${world.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [employee.id], prompt: '验证 cue/state 断点恢复' }),
    })
    const cue = await boundary.waitFor((event) => event.event === 'world-cue')
    boundary.close()

    const afterCueDisconnect = openWorldStream(origin, world.id, boundarySnapshot.body.sequence, cue.id)
    await afterCueDisconnect.connected
    const recoveryAfterCue = await afterCueDisconnect.waitFor((event) => event.event === 'recovery-required')
    const stateAfterCue = await afterCueDisconnect.waitFor((event) => event.event === 'world-state')
    expect(stateAfterCue.data.sequence).toBe(recoveryAfterCue.data.sequence)
    expect(afterCueDisconnect.events.filter((event) => event.event === 'world-cue')).toHaveLength(0)
    afterCueDisconnect.close()
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
        displayName: '公司 sub2api',
        providerKind: 'openai-compatible-local',
        baseUrl: 'http://172.16.1.125:11434/v1/',
        modelId: 'qwen3.5:9b',
        api: 'openai-completions',
        credentialEnvName: 'SUB2API_API_KEY',
        isDefault: true,
        settings: { providerId: 'custom-local' },
      }),
    })
    expect(model.response.status).toBe(201)
    expect(model.body.profile).not.toHaveProperty('credential')
    expect(model.body.profile.credentialEnvName).toBe('SUB2API_API_KEY')
    expect(model.body.profile.baseUrl).toBe('http://172.16.1.125:11434/v1')

    const updatedModel = await json(origin, `/api/workspaces/${workspace.id}/model-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...model.body.profile,
        displayName: '公司 sub2api（主线路）',
        modelId: 'qwen3.5',
        settings: { providerId: 'custom-local', contextWindow: 128_000 },
      }),
    })
    expect(updatedModel.response.status).toBe(201)
    expect(updatedModel.body.profile).toMatchObject({ id: model.body.profile.id, displayName: '公司 sub2api（主线路）', modelId: 'qwen3.5' })

    const worldAssignment = await json(
      origin,
      `/api/workspaces/${workspace.id}/model-assignments/world/${world.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelProfileId: model.body.profile.id }),
      },
    )
    const employeeAssignment = await json(
      origin,
      `/api/workspaces/${workspace.id}/model-assignments/employee/${employee.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelProfileId: model.body.profile.id }),
      },
    )
    expect(worldAssignment.response.status).toBe(200)
    expect(employeeAssignment.response.status).toBe(200)
    const modelSettings = await json(origin, `/api/workspaces/${workspace.id}/model-profiles`)
    expect(modelSettings.body.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'world', scopeId: world.id, modelProfileId: model.body.profile.id }),
      expect.objectContaining({ scope: 'employee', scopeId: employee.id, modelProfileId: model.body.profile.id }),
    ]))

    const deletedModel = await json(origin, `/api/workspaces/${workspace.id}/model-profiles/${model.body.profile.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
    expect(deletedModel.response.status).toBe(200)
    expect(deletedModel.body).toMatchObject({ removed: true, items: [], assignments: [] })

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

    const attachmentText = '# 北境徽章\n背面刻有月桂与断剑。'
    const attachment = await json(origin, `/api/workspaces/${workspace.id}/assets/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '北境徽章.md',
        mimeType: 'text/markdown',
        dataBase64: Buffer.from(attachmentText).toString('base64'),
      }),
    })
    expect(attachment.response.status).toBe(201)
    expect(attachment.body.attachment).toMatchObject({
      name: '北境徽章.md',
      mimeType: 'text/markdown',
      byteLength: Buffer.byteLength(attachmentText),
    })
    const attachmentDownload = await fetch(`${origin}${attachment.body.attachment.url}`)
    expect(attachmentDownload.status).toBe(200)
    expect(attachmentDownload.headers.get('content-type')).toBe('text/markdown')
    expect(await attachmentDownload.text()).toBe(attachmentText)

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

  it('searches verified market packages and activates installed plugin and talent entrypoints', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-marketplace-'))
    const runtime = new FakeRuntime()
    const { origin, server } = await start(stateRoot, runtime, undefined, resolve('marketplace'))
    const { workspace, world } = await createWorld(origin)
    const engineer = await recruit(origin, world.id, 'cyber-company.software-engineer')

    const plugins = await json(
      origin,
      `/api/marketplace?market=plugin&workspaceId=${workspace.id}&q=${encodeURIComponent('会议')}`,
    )
    expect(plugins.response.status).toBe(200)
    expect(plugins.body.items).toHaveLength(1)
    expect(plugins.body.items[0]).toMatchObject({
      market: 'plugin',
      verified: true,
      manifest: { id: 'official-meeting-notes', version: '1.0.0' },
    })

    const pluginPreview = await json(origin, `/api/workspaces/${workspace.id}/marketplace/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'official-meeting-notes', version: '1.0.0' }),
    })
    expect(pluginPreview.response.status).toBe(200)
    const pluginInstall = await json(origin, `/api/workspaces/${workspace.id}/marketplace/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'official-meeting-notes',
        version: '1.0.0',
        approvalToken: pluginPreview.body.preview.approvalToken,
      }),
    })
    expect(pluginInstall.response.status).toBe(201)

    const originalPluginPrompt = `/meeting-summary @${engineer.displayName} 整理本次发布评审`
    const chat = await json(origin, `/api/worlds/${world.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeIds: [engineer.id],
        prompt: originalPluginPrompt,
      }),
    })
    expect(chat.response.status).toBe(200)
    expect(runtime.calls[0]?.prompt).toContain('你是当前世界的会议纪要助手')
    expect(runtime.calls[0]?.prompt).toContain('整理本次发布评审')
    const pluginMessages = await json(origin, `/api/sessions/${chat.body.session.id}/messages`)
    expect(pluginMessages.body.items.find((message: { kind: string }) => message.kind === 'user')?.content)
      .toBe(originalPluginPrompt)

    const talentPreview = await json(origin, `/api/workspaces/${workspace.id}/marketplace/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'official-archivist', version: '1.0.0' }),
    })
    const talentInstall = await json(origin, `/api/workspaces/${workspace.id}/marketplace/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'official-archivist',
        version: '1.0.0',
        approvalToken: talentPreview.body.preview.approvalToken,
      }),
    })
    expect(talentInstall.response.status).toBe(201)

    const blueprints = await json(
      origin,
      `/api/catalog/blueprints?templateId=cyber-company&workspaceId=${workspace.id}`,
    )
    expect(blueprints.body.items).toContainEqual(
      expect.objectContaining({ id: 'official-archivist', displayName: '档案管理员' }),
    )
    const archivist = await recruit(origin, world.id, 'official-archivist')
    expect(archivist.displayName).toBe('档案管理员')

    const themePreview = await json(origin, `/api/workspaces/${workspace.id}/marketplace/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'official-cyber-nocturne', version: '1.0.1' }),
    })
    expect(themePreview.response.status).toBe(200)
    const themeInstall = await json(origin, `/api/workspaces/${workspace.id}/marketplace/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'official-cyber-nocturne',
        version: '1.0.1',
        approvalToken: themePreview.body.preview.approvalToken,
      }),
    })
    expect(themeInstall.response.status).toBe(201)
    const themes = await json(origin, `/api/worlds/${world.id}/themes`)
    expect(themes.body.items).toContainEqual(expect.objectContaining({
      packageId: 'official-cyber-nocturne',
      source: 'installed',
      active: false,
    }))
    const bound = await json(origin, `/api/worlds/${world.id}/theme-binding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bind', packageId: 'official-cyber-nocturne' }),
    })
    expect(bound.response.status).toBe(200)
    expect(bound.body.snapshot.themeId).toBe('official-cyber-nocturne')
    const boundManifest = await json(origin, `/api/worlds/${world.id}/theme-manifest`)
    expect(boundManifest.body.assets.every((asset: { src: string }) => asset.src.startsWith(`/api/worlds/${world.id}/theme-assets/`))).toBe(true)
    const packageAsset = await fetch(`${origin}${boundManifest.body.assets[0].src}`)
    expect(packageAsset.status).toBe(200)
    expect(packageAsset.headers.get('content-type')).toBe('image/png')
    expect(server.store.getWorldThemeBinding(world.id)).toMatchObject({ status: 'active', themeId: 'official-cyber-nocturne' })

    for (let index = 0; index < 100; index += 1) {
      const action = index % 2 === 0 ? 'bind' : 'fallback'
      const switched = await json(origin, `/api/worlds/${world.id}/theme-binding`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'bind'
          ? { action, packageId: 'official-cyber-nocturne' }
          : { action }),
      })
      expect(switched.response.status).toBe(200)
    }
    expect((await json(origin, `/api/worlds/${world.id}/themes`)).body.items.filter((item: { active: boolean }) => item.active)).toHaveLength(1)

    const fallback = await json(origin, `/api/worlds/${world.id}/theme-binding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fallback' }),
    })
    expect(fallback.body.snapshot.themeId).toBe('dsh-cyber.company.nocturne')
    expect(server.store.getWorldThemeBinding(world.id)?.status).toBe('disabled')
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

  it('persists the staged DSH update state machine, explicit activation, and rollback', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-update-'))
    const { origin, server } = await start(stateRoot)
    const verified = await json(origin, '/api/system/update/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateRoot: resolve('packages/harness-adapter') }),
    })
    expect(verified.response.status).toBe(201)
    expect(verified.body).toMatchObject({
      ok: true,
      version: '0.1.0-rc.7',
      transaction: { status: 'verified' },
    })
    const transactionId = verified.body.transaction.id as string

    const unapproved = await json(origin, `/api/system/update/${transactionId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    })
    expect(unapproved.response.status).toBe(409)
    expect(unapproved.body.error.code).toBe('runtime_activation_approval_required')

    const contract = await json(origin, `/api/system/update/${transactionId}/contract-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(contract.response.status).toBe(200)
    expect(contract.body.transaction.status).toBe('contract-tested')

    const missingModel = await json(origin, `/api/system/update/${transactionId}/canary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(missingModel.response.status).toBe(422)

    server.store.transitionRuntimeUpdate({
      transactionId,
      status: 'canary-passed',
      report: { ok: true, evidence: 'real Harness canary is covered by harness-adapter integration' },
    })
    const activated = await json(origin, `/api/system/update/${transactionId}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    expect(activated.response.status).toBe(200)
    expect(activated.body).toMatchObject({
      ok: true,
      restartRequired: true,
      transaction: { status: 'activated' },
    })

    const updates = await json(origin, '/api/system/updates')
    expect(updates.body.activeRuntime).toMatchObject({ transactionId, version: '0.1.0-rc.7' })
    expect(updates.body.items[0]).toMatchObject({ id: transactionId, status: 'activated' })

    const rolledBack = await json(origin, `/api/system/update/${transactionId}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    })
    expect(rolledBack.response.status).toBe(200)
    expect(rolledBack.body.transaction.status).toBe('rolled-back')
    const afterRollback = await json(origin, '/api/system/updates')
    expect(afterRollback.body.activeRuntime).toBeUndefined()
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

interface TestSseEvent {
  id?: string
  event: string
  data: any
}

function openWorldStream(origin: string, worldId: string, after: number, lastEventId?: string): {
  connected: Promise<void>
  events: TestSseEvent[]
  waitFor(predicate: (event: TestSseEvent) => boolean): Promise<TestSseEvent>
  close(): void
} {
  const target = new URL(origin)
  const events: TestSseEvent[] = []
  const waiters: Array<{
    predicate: (event: TestSseEvent) => boolean
    resolve(event: TestSseEvent): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }> = []
  let buffer = ''
  let resolveConnected!: () => void
  let rejectConnected!: (error: Error) => void
  const connected = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveConnected = resolvePromise
    rejectConnected = rejectPromise
  })
  const headers: Record<string, string> = { Host: target.host }
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId
  const request = httpRequest({
    hostname: '127.0.0.1',
    port: Number(target.port),
    method: 'GET',
    path: `/api/worlds/${encodeURIComponent(worldId)}/stream?after=${after}`,
    headers,
  }, (response) => {
    resolveConnected()
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk.replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const eventName = /^event:\s*(.+)$/m.exec(block)?.[1]
        const data = /^data:\s*(.+)$/m.exec(block)?.[1]
        const id = /^id:\s*(.+)$/m.exec(block)?.[1]
        if (eventName !== undefined && data !== undefined) {
          const parsed: TestSseEvent = {
            event: eventName,
            data: JSON.parse(data),
            ...(id === undefined ? {} : { id }),
          }
          events.push(parsed)
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(parsed)) continue
            clearTimeout(waiter.timer)
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve(parsed)
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    })
  })
  request.once('error', (error) => {
    rejectConnected(error)
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  })
  request.end()
  return {
    connected,
    events,
    waitFor(predicate) {
      const current = events.find(predicate)
      if (current !== undefined) return Promise.resolve(current)
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = {
          predicate,
          resolve: resolvePromise,
          reject: rejectPromise,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1)
            rejectPromise(new Error(`Timed out waiting for world SSE event; received ${events.map((event) => event.event).join(', ')}`))
          }, 2_000),
        }
        waiters.push(waiter)
      })
    },
    close() { request.destroy() },
  }
}
