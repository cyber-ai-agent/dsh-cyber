import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('delegated collaboration atomic ingress', () => {
  it('claims before peer work, waits for same-process duplicates, and continues the one original WorkTurn', async () => {
    const runtime = new HeldDelegatedRuntime()
    const { origin, server, world, initiator, target } = await start(runtime)
    const request = {
      employeeIds: [initiator.id],
      prompt: `请帮我向 @${target.displayName} 确认当前进度，然后回来告诉我。`,
      clientTurnId: 'delegated-atomic-once',
    }

    const first = post(origin, world.id, request)
    await runtime.peerEntered
    const duplicate = post(origin, world.id, request)
    await waitFor(() => runtime.calls.length === 1)
    runtime.releasePeer()

    const [firstResult, duplicateResult] = await Promise.all([first, duplicate])
    expect(firstResult.response.status).toBe(200)
    expect(duplicateResult.response.status).toBe(200)
    expect(duplicateResult.body.workTurnId).toBe(firstResult.body.workTurnId)
    expect(duplicateResult.body.session.id).toBe(firstResult.body.session.id)
    expect(runtime.calls).toHaveLength(3)

    const directSessionId = firstResult.body.session.id as string
    const workTurnId = firstResult.body.workTurnId as string
    expect(server.store.listSessionTurns(directSessionId)).toHaveLength(1)
    expect(server.store.listMessages(directSessionId).filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(server.store.getWorkTurn(workTurnId)).toMatchObject({ status: 'completed', clientTurnId: request.clientTurnId })
    expect(server.store.listSessions(world.id).filter((session) => session.kind === 'meeting')).toHaveLength(1)
    expect(server.store.listMessages(directSessionId).find((message) => message.kind === 'user')?.metadata).toMatchObject({
      delegatedWorkflow: true,
      delegatedParticipantIds: [initiator.id, target.id],
      delegatedPeerSessionId: expect.any(String),
      delegatedEpisodeId: expect.any(String),
    })
    expect(duplicateResult.body.delegation).toMatchObject({
      participantIds: [initiator.id, target.id],
      episodeId: expect.any(String),
    })
  })

  it('fails closed when delegation is combined with queueMode before creating a claim or running a model', async () => {
    const runtime = new RecordingRuntime()
    const { origin, server, world, initiator, target } = await start(runtime)
    const response = await post(origin, world.id, {
      employeeIds: [initiator.id],
      prompt: `请帮我向 @${target.displayName} 确认当前进度，然后回来告诉我。`,
      clientTurnId: 'delegated-queue-rejected',
      queueMode: 'normal',
    })

    expect(response.response.status).toBe(422)
    expect(response.body.error).toMatchObject({ code: 'delegation_queue_unsupported' })
    expect(server.store.getConversationSubmissionClaim(world.workspaceId, world.id, 'delegated-queue-rejected')).toBeUndefined()
    expect(server.store.listSessions(world.id).filter((session) => session.kind === 'meeting')).toHaveLength(0)
    expect(runtime.calls).toHaveLength(0)
  })

  it('marks the claimed original turn on peer failure and terminal replay never reruns peer work', async () => {
    const runtime = new FailingPeerRuntime()
    const { origin, server, world, initiator, target } = await start(runtime)
    const request = {
      employeeIds: [initiator.id],
      prompt: `请帮我向 @${target.displayName} 确认当前进度，然后回来告诉我。`,
      clientTurnId: 'delegated-peer-failure',
    }

    const failed = await post(origin, world.id, request)
    expect(failed.response.status).toBeGreaterThanOrEqual(500)
    const claim = server.store.getConversationSubmissionClaim(world.workspaceId, world.id, request.clientTurnId)
    expect(claim).toBeDefined()
    expect(server.store.getWorkTurn(claim!.workTurn.id)).toMatchObject({ status: 'failed' })
    expect(runtime.calls).toHaveLength(1)

    const replay = await post(origin, world.id, request)
    expect(replay.response.status).toBe(200)
    expect(replay.body.workTurnId).toBe(claim!.workTurn.id)
    expect(runtime.calls).toHaveLength(1)
    expect(server.store.listSessions(world.id).filter((session) => session.kind === 'meeting')).toHaveLength(1)
  })
})

class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    return {
      agentSessionId: `runtime-${request.agent.id}`,
      finalResponse: `${request.agent.displayName} 已完成本轮工作。`,
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}

class HeldDelegatedRuntime extends RecordingRuntime {
  readonly peerEntered: Promise<void>
  #resolvePeerEntered!: () => void
  #releasePeer!: () => void
  #holdPeer = true

  constructor() {
    super()
    this.peerEntered = new Promise<void>((resolve) => { this.#resolvePeerEntered = resolve })
  }

  releasePeer(): void {
    this.#releasePeer?.()
  }

  override async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    if (this.#holdPeer && request.prompt.includes('你正在参加同一世界内的一次真实角色协作')) {
      this.#holdPeer = false
      this.#resolvePeerEntered()
      await new Promise<void>((resolve) => { this.#releasePeer = resolve })
    }
    return {
      agentSessionId: `runtime-${request.agent.id}`,
      finalResponse: `${request.agent.displayName} 已完成本轮工作。`,
      eventCount: 0,
    }
  }
}

class FailingPeerRuntime extends RecordingRuntime {
  override async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    if (request.prompt.includes('你正在参加同一世界内的一次真实角色协作')) {
      throw new Error('peer runtime failed')
    }
    return {
      agentSessionId: `runtime-${request.agent.id}`,
      finalResponse: `${request.agent.displayName} 已完成本轮工作。`,
      eventCount: 0,
    }
  }
}

async function start(runtime: AgentRuntimePort): Promise<{
  origin: string
  server: CyberServer
  world: ReturnType<CyberServer['store']['getWorld']> & {}
  initiator: NonNullable<ReturnType<CyberServer['store']['getEmployee']>>
  target: NonNullable<ReturnType<CyberServer['store']['getEmployee']>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delegated-atomic-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
  })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const initiator = server.store.listEmployees(world.id).find((employee) => employee.displayName === '管家')!
  const target = server.store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'core.butler',
    blueprintVersion: 1,
    displayName: '委派目标',
  })
  return { origin, server, world, initiator, target }
}

async function post(origin: string, worldId: string, body: unknown): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}/api/worlds/${worldId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for delegated peer execution')
}
