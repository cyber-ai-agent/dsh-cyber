import { createHash } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import { SqliteStore } from '@dsh-cyber/persistence'

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
  it('preserves an existing immutable built-in blueprint identity during startup', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-existing-blueprint-'))
    const store = await SqliteStore.open(join(stateRoot, 'data', 'dsh-cyber.sqlite'))
    const builtIn = BUILTIN_BLUEPRINTS[0]!
    store.saveBlueprint({ ...builtIn, summary: '由旧版本持久化的蓝图定义' })
    store.close()

    const { server } = await start(stateRoot)
    expect(server.store.getBlueprint(builtIn.id, builtIn.version)?.summary).toBe('由旧版本持久化的蓝图定义')
  })

  it('starts loopback-only with an empty world and independent role catalogs', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-'))
    const { origin } = await start(stateRoot)

    const workspaces = await json(origin, '/api/workspaces')
    expect(workspaces.body.items).toEqual([])
    const templates = await json(origin, '/api/catalog/world-templates')
    expect(templates.body.items.map((item: { id: string }) => item.id)).toEqual([
      'personal-world',
      'cyber-company',
      'tavern',
      'creator-studio',
      'orbital-observatory',
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
    const skillDefinition = `${JSON.stringify({
      schemaVersion: 1,
      id: 'local.skill',
      displayName: '本地技能',
      summary: '测试最小权限安装。',
      integrationId: 'builtin.local',
      dataEgress: [],
      instructions: '只用于验证包安装。',
    })}\n`
    await writeFile(join(sourceV1, 'skill.json'), skillDefinition, 'utf8')
    await writeFile(join(sourceV2, 'skill.json'), '# tampered\n', 'utf8')
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
      entrypoints: [{ id: 'local.skill', kind: 'skill', path: 'skill.json' }],
      files: [
        {
          path: 'skill.json',
          sha256: createHash('sha256').update(skillDefinition).digest('hex'),
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
      files: [{ path: 'skill.json', sha256: packageManifest.files[0]!.sha256 }],
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
        clientTurnId: 'client-turn-group',
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
    expect(runtimeEvents.every((item) => item.event.metadata.clientTurnId === 'client-turn-group')).toBe(true)
    expect(runtimeEvents.every((item) => item.agentRunId === item.event.metadata.traceTurnId)).toBe(true)
    expect(runtimeEvents.every((item) => item.workTurnId === item.event.metadata.workTurnId)).toBe(true)

    const turns = await json(first.origin, `/api/sessions/${sessionId}/turns`)
    expect(turns.response.status).toBe(200)
    expect(turns.body.items).toHaveLength(1)
    const turnId = turns.body.items[0].id as string
    const turnDetail = await json(first.origin, `/api/turns/${turnId}`)
    expect(turnDetail.body.turn).toMatchObject({ id: turnId, status: 'completed', interactionKind: 'chat' })
    expect(turnDetail.body.runs).toEqual([
      expect.objectContaining({ employeeId: engineer.id, ordinal: 1, status: 'completed' }),
      expect.objectContaining({ employeeId: archivist.id, ordinal: 2, status: 'completed' }),
    ])
    const staleTurn = first.server.store.createWorkTurn({
      workspaceId: workspace.id, worldId: world.id, sessionId, interactionKind: 'task',
    })
    first.server.store.startWorkTurn(staleTurn.id)
    const staleRun = first.server.store.createAgentRun({
      workspaceId: workspace.id, worldId: world.id, sessionId, turnId: staleTurn.id,
      employeeId: engineer.id, ordinal: 1,
    })
    first.server.store.startAgentRun(staleRun.id)

    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    const second = await start(stateRoot, new FakeRuntime())
    expect(second.server.store.getWorkTurn(staleTurn.id)).toMatchObject({ status: 'interrupted', errorCode: 'service-restarted' })
    expect(second.server.store.getAgentRun(staleRun.id)).toMatchObject({ status: 'failed', errorCode: 'service-restarted' })
    const workspaceSnapshot = await json(second.origin, `/api/workspaces/${workspace.id}/snapshot`)
    const worldSnapshot = await json(second.origin, `/api/worlds/${world.id}/snapshot`)
    const messages = await json(second.origin, `/api/sessions/${sessionId}/messages`)
    expect(workspaceSnapshot.body.worlds).toHaveLength(1)
    expect(worldSnapshot.body.employees).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'assistant')).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'reasoning')).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'tool-call')).toHaveLength(2)
    expect(messages.body.items.filter((item: { kind: string }) => item.kind === 'tool-result')).toHaveLength(2)
    expect(messages.body.items
      .filter((item: { kind: string }) => item.kind === 'user' || item.kind === 'assistant')
      .every((item: { metadata: { clientTurnId?: string } }) => item.metadata.clientTurnId === 'client-turn-group')).toBe(true)
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
    // Rejected before the hub is touched, not after: restoreCanonicalDirect
    // writes the other world's conversation state, so the world check has to
    // happen ahead of it rather than downstream in the orchestrator.
    expect(leakedSession.body.error.code).toBe('session_unavailable')
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
    const invalidPreferences = await json(origin, `/api/workspaces/${workspace.id}/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rightPaneWidth: 761 }),
    })
    expect(invalidPreferences.response.status).toBe(422)
    expect(invalidPreferences.body.error).toMatchObject({
      code: 'workspace_preferences_out_of_range',
      message: expect.stringContaining('300 到 760'),
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

    const worldAttachmentText = '世界专属资料：只应在当前世界的会话中可用。'
    const worldAttachment = await json(origin, `/api/worlds/${world.id}/assets/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '世界资料.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from(worldAttachmentText).toString('base64'),
      }),
    })
    expect(worldAttachment.response.status).toBe(201)
    const worldAttachmentDownload = await fetch(`${origin}${worldAttachment.body.attachment.url}`)
    expect(worldAttachmentDownload.status).toBe(200)
    expect(await worldAttachmentDownload.text()).toBe(worldAttachmentText)
    const chatWithWorldAttachment = await json(origin, `/api/worlds/${world.id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeIds: [employee.id],
        prompt: '请阅读世界资料并确认收到',
        attachments: [{ ...worldAttachment.body.attachment, name: '客户端不可信的文件名.txt' }],
      }),
    })
    expect(chatWithWorldAttachment.response.status).toBe(200)
    const attachmentMessages = await json(origin, `/api/sessions/${chatWithWorldAttachment.body.session.id}/messages`)
    expect(attachmentMessages.body.items.find((item: { kind: string }) => item.kind === 'user')?.metadata.attachments).toContainEqual(
      expect.objectContaining({ name: '世界资料.txt', mimeType: 'text/plain' }),
    )

    const status = await json(origin, '/api/system/status')
    expect(status.response.status).toBe(200)
    expect(status.body).toMatchObject({ ok: true, database: { ok: true }, compatibility: { ok: true } })
    const doctor = await json(origin, '/api/system/doctor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(doctor.body).toMatchObject({ ok: true, database: { integrity: ['ok'] } })
    const backup = await json(origin, '/api/system/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const exported = await json(origin, '/api/system/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(backup.body).toMatchObject({ kind: 'backup', format: 'dsh-cyber-local-backup', bundle: true })
    expect((await stat(backup.body.output)).isFile()).toBe(true)
    expect((await stat(exported.body.output)).isFile()).toBe(true)

    const dossier = await json(origin, `/api/employees/${employee.id}/dossier`)
    expect(dossier.body.profile).toMatchObject({ birthday: '05-24', personalityTraits: ['严谨', '主动'] })
    expect(dossier.body.profile.appearance).toMatchObject({ avatarIndex: 6 })
    expect(dossier.body.employee.displayName).toBe('阿帆')
    expect(dossier.body.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'joined' }),
    ]))
  })

  it('stores direct model API keys outside SQLite and restores them after restart', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-model-credentials-'))
    const secret = 'sk-server-integration-test-only'
    let started = await start(stateRoot)
    const workspaceResult = await json(started.origin, '/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Model credential workspace' }),
    })
    const workspaceId = workspaceResult.body.workspace.id as string
    const rejectedSecret = 'sk-rejected-profile-test-only'
    const rejected = await json(started.origin, `/api/workspaces/${workspaceId}/model-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Invalid remote model',
        providerKind: 'openai-compatible-remote',
        baseUrl: 'http://public.example.test/v1',
        modelId: 'invalid-test',
        api: 'openai-completions',
        apiKey: rejectedSecret,
      }),
    })
    expect(rejected.response.status).toBe(422)
    expect(rejected.body.error.message).toBe('公网模型服务必须使用 HTTPS 地址。')
    const rejectedVault = await readFile(join(stateRoot, 'credentials', 'model-credentials.json'), 'utf8').catch(() => '')
    expect(rejectedVault).not.toContain(rejectedSecret)

    const saved = await json(started.origin, `/api/workspaces/${workspaceId}/model-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Private sub2api',
        providerKind: 'openai-compatible-remote',
        baseUrl: 'https://models.example.test/v1',
        modelId: 'qwen-test',
        api: 'openai-completions',
        apiKey: secret,
        isDefault: true,
        settings: {
          webSearchEnabled: true,
          webSearchBaseUrl: 'https://search.example.test/anthropic/v1',
        },
      }),
    })
    expect(saved.response.status).toBe(201)
    expect(saved.body.profile).not.toHaveProperty('apiKey')
    expect(saved.body.profile.credentialEnvName).toMatch(/^DSH_CYBER_MODEL_KEY_[A-F0-9]{24}$/)
    expect(saved.body.profile.settings).toMatchObject({
      webSearchEnabled: true,
      webSearchBaseUrl: 'https://search.example.test/anthropic/v1',
    })
    const envName = saved.body.profile.credentialEnvName as string

    const listed = await json(started.origin, `/api/workspaces/${workspaceId}/model-profiles`)
    expect(listed.body.items[0]).toMatchObject({ credentialConfigured: true })
    expect(JSON.stringify(listed.body)).not.toContain(secret)
    expect(await readFile(join(stateRoot, 'credentials', 'model-credentials.json'), 'utf8')).not.toContain(secret)
    expect((await readFile(join(stateRoot, 'data', 'dsh-cyber.sqlite'))).includes(Buffer.from(secret))).toBe(false)

    await started.server.close()
    expect(process.env[envName]).toBeUndefined()
    started = await start(stateRoot)
    const restored = await json(started.origin, `/api/workspaces/${workspaceId}/model-profiles`)
    expect(restored.body.items[0]).toMatchObject({ id: saved.body.profile.id, credentialConfigured: true })

    const removed = await json(started.origin, `/api/workspaces/${workspaceId}/model-profiles/${saved.body.profile.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(removed.body).toMatchObject({ removed: true, items: [] })
    expect(process.env[envName]).toBeUndefined()
  })

  it('discovers provider models with the submitted API key without returning the key', async () => {
    const secret = 'sk-discovery-route-test-only'
    let authorized = false
    const upstream = createHttpServer((request, response) => {
      authorized = request.headers.authorization === `Bearer ${secret}`
      response.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' })
      response.end(authorized ? JSON.stringify({ data: [{ id: 'qwen-test' }, { id: 'deepseek-test' }] }) : '{}')
    })
    await new Promise<void>((resolvePromise) => upstream.listen(0, '127.0.0.1', resolvePromise))
    try {
      const address = upstream.address()
      if (address === null || typeof address === 'string') throw new Error('Model catalog test server did not start')
      const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-model-discovery-'))
      const { origin } = await start(stateRoot)
      const workspaceResult = await json(origin, '/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Model discovery workspace' }),
      })
      const discovered = await json(origin, `/api/workspaces/${workspaceResult.body.workspace.id}/model-profiles/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          apiKey: secret,
        }),
      })
      expect(discovered.response.status).toBe(200)
      expect(authorized).toBe(true)
      expect(discovered.body.items).toEqual([{ id: 'deepseek-test' }, { id: 'qwen-test' }])
      expect(JSON.stringify(discovered.body)).not.toContain(secret)
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => upstream.close((error) => error ? rejectPromise(error) : resolvePromise()))
    }
  })


it('browses and previews safe world files without exposing hidden files or traversal', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-server-files-'))
  const { origin } = await start(stateRoot)
  const { world } = await createWorld(origin)
  const filesRoot = join(stateRoot, 'worlds', encodeURIComponent(world.id), 'files')
  await mkdir(join(filesRoot, 'src'), { recursive: true })
  await writeFile(join(filesRoot, 'src', 'hello.ts'), 'export const hello = "cyber"\n', 'utf8')
  await writeFile(join(filesRoot, '.env'), 'SECRET_MUST_NOT_LEAK=value\n', 'utf8')

  const root = await json(origin, `/api/worlds/${world.id}/files`)
  expect(root.response.status).toBe(200)
  expect(root.body.items.map((item: { name: string }) => item.name)).toContain('src')
  expect(root.body.items.map((item: { name: string }) => item.name)).not.toContain('.env')

  const nested = await json(origin, `/api/worlds/${world.id}/files?path=src`)
  expect(nested.body).toMatchObject({ path: 'src', parentPath: '' })
  expect(nested.body.items).toEqual([
    expect.objectContaining({ name: 'hello.ts', kind: 'file', previewKind: 'text' }),
  ])
  const preview = await fetch(`${origin}/api/worlds/${world.id}/file?path=src%2Fhello.ts`)
  expect(preview.status).toBe(200)
  expect(preview.headers.get('content-type')).toContain('text/plain')
  expect(await preview.text()).toContain('export const hello')

  const hidden = await fetch(`${origin}/api/worlds/${world.id}/file?path=.env`)
  expect(hidden.status).toBe(403)
  const traversal = await fetch(`${origin}/api/worlds/${world.id}/files?path=..%2F`)
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
      activation: {
        kind: 'prompt-transform',
        automatic: false,
        commands: [{ trigger: '/meeting-summary' }],
      },
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
        worldId: world.id,
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
        worldId: world.id,
      }),
    })
    expect(talentInstall.response.status).toBe(201)

    const talents = await json(origin, `/api/marketplace?market=talent&workspaceId=${workspace.id}&q=${encodeURIComponent('档案')}`)
    expect(talents.body.items[0]).toMatchObject({
      manifest: { id: 'official-archivist' },
      installedVersion: '1.0.0',
      activation: {
        kind: 'employee-blueprint',
        blueprintId: 'official-archivist',
        blueprintVersion: 1,
        worldTemplateId: 'cyber-company',
      },
    })

    const blueprints = await json(
      origin,
      `/api/catalog/blueprints?templateId=cyber-company&worldId=${world.id}`,
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

    const themeCatalog = await json(origin, `/api/marketplace?market=theme&workspaceId=${workspace.id}`)
    expect(themeCatalog.body.items).toHaveLength(4)
    expect(themeCatalog.body.items.find((item: { manifest: { id: string } }) => item.manifest.id === 'official-cyber-nocturne')).toMatchObject({
      activation: {
        kind: 'world-theme',
        themeId: 'official-cyber-nocturne',
        themeVersion: '1.0.1',
        templateId: 'cyber-company',
      },
    })
    const visualPreview = await fetch(`${origin}/api/marketplace/packages/official-moonlit-tavern/1.0.0/preview`)
    expect(visualPreview.status).toBe(200)
    expect(visualPreview.headers.get('content-type')).toBe('image/png')
    expect((await visualPreview.arrayBuffer()).byteLength).toBeGreaterThan(100_000)

    const tavernPreview = await json(origin, `/api/workspaces/${workspace.id}/marketplace/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'official-moonlit-tavern', version: '1.0.0' }),
    })
    const tavernInstall = await json(origin, `/api/workspaces/${workspace.id}/marketplace/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'official-moonlit-tavern',
        version: '1.0.0',
        approvalToken: tavernPreview.body.preview.approvalToken,
      }),
    })
    expect(tavernInstall.response.status).toBe(201)
    const createdTavern = await json(origin, `/api/workspaces/${workspace.id}/marketplace/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'official-moonlit-tavern', name: '月影酒馆' }),
    })
    expect(createdTavern.response.status).toBe(201)
    expect(createdTavern.body.world).toMatchObject({ name: '月影酒馆', templateId: 'tavern' })
    expect(createdTavern.body.employees.map((item: { displayName: string }) => item.displayName)).toEqual([
      '酒馆老板', '吟游诗人', '远行制图师',
    ])
    const tavernSnapshot = await json(origin, `/api/worlds/${createdTavern.body.world.id}/runtime-snapshot`)
    expect(tavernSnapshot.body.themeId).toBe('official-moonlit-tavern')
    expect(server.store.getWorldThemeBinding(createdTavern.body.world.id)).toMatchObject({
      packageId: 'official-moonlit-tavern',
      status: 'active',
    })
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
      version: '0.1.1-rc.1',
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
    expect(updates.body.activeRuntime).toMatchObject({ transactionId, version: '0.1.1-rc.1' })
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

  it('returns bounded chat pages and searchable dated history', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-message-page-'))
    const { server, origin } = await start(stateRoot)
    const { workspace, world } = await createWorld(origin)
    const session = server.store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '历史分页',
      participants: [{ participantId: 'owner', kind: 'owner' }],
    })
    for (let index = 1; index <= 25; index += 1) {
      server.store.appendMessage({
        sessionId: session.id,
        senderId: 'owner',
        senderKind: 'owner',
        kind: 'user',
        content: `可搜索消息 ${index}`,
      })
    }
    const latest = await json(origin, `/api/sessions/${session.id}/messages?view=chat&limit=20`)
    expect(latest.response.status).toBe(200)
    expect(latest.body.items).toHaveLength(20)
    expect(latest.body.hasMore).toBe(true)
    expect(latest.body.items[0].sequence).toBe(6)
    const history = await json(origin, `/api/sessions/${session.id}/messages?view=chat&limit=20&page=1&q=消息%202`)
    expect(history.response.status).toBe(200)
    expect(history.body.total).toBe(7)
    expect(history.body.items.every((item: { content: string }) => item.content.includes('消息 2'))).toBe(true)
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
