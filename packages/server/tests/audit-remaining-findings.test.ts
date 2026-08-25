import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, World } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const stores: SqliteStore[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed by the test.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }
  async close(): Promise<void> {}
}

async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-remaining-'))
  roots.push(stateRoot)
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime: new QuietRuntime(),
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  const address = await server.start()
  return { origin: address.origin, server, stateRoot }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function firstWorld(origin: string): Promise<{ workspaceId: string; world: World }> {
  const workspaces = await json(origin, '/api/workspaces')
  const workspaceId = workspaces.body.items[0].id as string
  const worlds = await json(origin, `/api/workspaces/${workspaceId}/worlds`)
  return { workspaceId, world: worlds.body.items[0] as World }
}

describe('recruit requires a world instance of the blueprint', () => {
  it('refuses a workspace-global blueprint the world holds no instance of', async () => {
    const { origin, server } = await start()
    const { world } = await firstWorld(origin)
    // A blueprint present workspace-wide but never instantiated into this world
    // used to be recruitable through a direct API call.
    server.store.saveBlueprint({
      schemaVersion: 1,
      id: 'not-instantiated',
      version: 1,
      worldTemplateId: 'personal-world',
      displayName: '幽灵角色',
      role: '不存在的岗位',
      summary: '这个蓝图没有在任何世界实例化。',
      persona: '你不应该被招募进来。',
      requestedSkills: [],
      requestedCapabilities: [],
      createdAt: '2026-08-24T00:00:00.000Z',
    })

    const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'not-instantiated',
      blueprintVersion: 1,
    }))
    expect(recruited.response.status).toBe(422)
    expect(recruited.body.error.code).toBe('blueprint_not_available_in_world')
  })

  it('still recruits a built-in blueprint', async () => {
    const { origin } = await start()
    const { world } = await firstWorld(origin)
    const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
    const blueprintId = snapshot.body.employees[0].blueprintId as string
    const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({ blueprintId, blueprintVersion: 1 }))
    expect(recruited.response.status).toBeLessThan(300)
  })
})

describe('a client-supplied session id cannot reach another world', () => {
  it('rejects before the conversation hub of the other world is written', async () => {
    const { origin, server } = await start()
    const { workspaceId, world } = await firstWorld(origin)
    const other = await json(origin, `/api/workspaces/${workspaceId}/worlds`, post({ name: '另一个世界', templateId: 'personal-world' }))
    const otherWorld = other.body.world as World
    const otherSession = server.store.createSession({
      workspaceId,
      worldId: otherWorld.id,
      kind: 'direct',
      title: '另一个世界的私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }],
    })
    const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
    const characterId = snapshot.body.employees[0].id as string

    const leaked = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: [characterId],
      sessionId: otherSession.id,
      prompt: '你好',
    }))
    expect(leaked.response.status).toBe(422)
    expect(leaked.body.error.code).toBe('session_unavailable')
  })
})

describe('history retention', () => {
  it('prunes telemetry and keeps the conversation and the action ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-prune-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '世界', templateId: 'personal-world' })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }],
    })
    store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '很久以前说过的话' })
    const eventsBefore = store.listWorldDomainEvents(world.id).length
    expect(eventsBefore).toBeGreaterThan(0)

    const result = store.pruneHistory({ before: new Date(Date.now() + 60_000).toISOString() })
    // Workspace-scoped events are telemetry too, so the sweep is at least as
    // large as the world-scoped subset.
    expect(result.domainEvents).toBeGreaterThanOrEqual(eventsBefore)
    expect(store.listWorldDomainEvents(world.id)).toEqual([])
    // Conversations are user content, not telemetry.
    expect(store.listMessages(session.id).map((message) => message.content)).toEqual(['很久以前说过的话'])
    expect(store.getSession(session.id)).toBeDefined()
    expect(store.getWorld(world.id)).toBeDefined()
  })

  it('keeps everything newer than the cutoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-prune-keep-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '世界', templateId: 'personal-world' })
    const before = store.listWorldDomainEvents(world.id).length

    const result = store.pruneHistory({ before: '2020-01-01T00:00:00.000Z' })
    expect(result.domainEvents).toBe(0)
    expect(store.listWorldDomainEvents(world.id)).toHaveLength(before)
  })

  it('refuses a cutoff it cannot parse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-prune-bad-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    expect(() => store.pruneHistory({ before: 'not-a-date' })).toThrow(/Invalid prune cutoff/)
  })
})

describe('a failed run does not put words in a character mouth', () => {
  it('marks partial output unfinished so it is never replayed as recovered history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-failed-run-'))
    roots.push(root)
    const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
    stores.push(store)
    const workspace = store.createWorkspace({ name: '工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '世界', templateId: 'personal-world' })
    const session = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'direct',
      title: '私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }],
    })
    store.saveBlueprint({
      schemaVersion: 1,
      id: 'test-character',
      version: 1,
      worldTemplateId: 'personal-world',
      displayName: '小刘',
      role: '软件工程师',
      summary: '测试角色。',
      persona: '你是小刘。',
      requestedSkills: [],
      requestedCapabilities: [],
      createdAt: '2026-08-24T00:00:00.000Z',
    })
    const character = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'test-character',
      blueprintVersion: 1,
    })
    const turn = store.createWorkTurn({
      workspaceId: workspace.id,
      worldId: world.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })
    store.startWorkTurn(turn.id)
    const run = store.createAgentRun({
      workspaceId: workspace.id,
      worldId: world.id,
      turnId: turn.id,
      sessionId: session.id,
      employeeId: character.id,
      ordinal: 1,
    })
    store.startAgentRun(run.id)
    const partial = store.appendMessage({
      sessionId: session.id,
      senderId: character.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: '我正在分析这个问题，首先',
      metadata: { agentRunId: run.id },
    })

    store.failAgentRun(run.id, 'runtime-turn-failed')

    const stored = store.listMessages(session.id).find((message) => message.id === partial.id)!
    // The user watched it arrive, so it stays in the transcript…
    expect(stored.content).toBe('我正在分析这个问题，首先')
    // …but it is flagged, and buildConversationHistory drops flagged rows.
    expect(stored.metadata.failed).toBe(true)
  })
})

describe('a corrupt legacy ledger does not stop the application', () => {
  it('starts and serves even when skills/actions.json cannot be parsed', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-legacy-'))
    roots.push(stateRoot)
    await mkdir(join(stateRoot, 'skills'), { recursive: true })
    await writeFile(join(stateRoot, 'skills', 'actions.json'), '{ this is not json')

    const server = await createCyberServer({
      stateRoot,
      workspacePath: stateRoot,
      port: 0,
      runtime: new QuietRuntime(),
      bootstrapDefaultWorld: true,
    })
    servers.push(server)
    const address = await server.start()
    const workspaces = await json(address.origin, '/api/workspaces')
    expect(workspaces.response.status).toBe(200)
  })
})
