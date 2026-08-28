import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeBlueprint,
} from '@dsh-cyber/contracts'
import type {
  GroupTurnPlan,
  GroupTurnPlannerPort,
} from '@dsh-cyber/orchestration'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
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

function blueprint(id: string, name: string, role: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: name,
    role,
    summary: `${role}测试角色`,
    persona: `你是${name}，只完成明确分配给你的工作。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for real collaboration state')
}

async function start() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-real-collab-'))
  const runtime = new RecordingRuntime()
  const planner: GroupTurnPlannerPort = {
    async plan(input): Promise<GroupTurnPlan> {
      const target = input.candidates.find((candidate) => candidate.displayName === '安全专家') ?? input.candidates[0]!
      return {
        source: 'model',
        waves: [{ speakers: [{ employeeId: target.employeeId, brief: '只处理登录安全问题' }] }],
        rationale: '本轮只需要安全专家',
      }
    },
  }
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
    groupTurnPlanner: planner,
  })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  server.store.saveBlueprint(blueprint('real.product', '产品经理', '产品经理'))
  server.store.saveBlueprint(blueprint('real.security', '安全专家', '安全专家'))
  const product = server.store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'real.product', blueprintVersion: 1 })
  const security = server.store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'real.security', blueprintVersion: 1 })
  const butler = server.store.listEmployees(world.id).find((employee) => employee.id !== product.id && employee.id !== security.id)!
  return { origin, server, runtime, workspace, world, product, security, butler }
}

describe('Real Collaboration group routing', () => {
  it('keeps all room members in the session while reserving/running only the planned expert', async () => {
    const { origin, server, runtime, world, product, security, butler } = await start()
    const memberIds = [product.id, security.id, butler.id]
    const group = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({
      title: '登录问题协作群',
      employeeIds: memberIds,
      collaborationMode: 'discussion',
    }))
    expect(group.response.status).toBe(201)

    const turn = await json(origin, `/api/worlds/${world.id}/chat`, post({
      sessionId: group.body.session.id,
      employeeIds: memberIds,
      prompt: '登录偶尔串号，找最合适的人看一下。',
      queueMode: 'normal',
      collaborationMode: 'discussion',
      clientTurnId: 'real-collab-one-expert',
    }))

    expect(turn.response.status).toBe(202)
    expect(turn.body.queueItem.employeeIds).toEqual([security.id])
    const participantIds = server.store.listParticipants(group.body.session.id)
      .filter((participant) => participant.kind === 'employee')
      .map((participant) => participant.participantId)
    expect(participantIds).toEqual(expect.arrayContaining(memberIds))
    expect(participantIds).toHaveLength(3)

    await waitFor(() => server.store.getWorkTurn(turn.body.workTurnId)?.status === 'completed')
    expect(runtime.calls.map((call) => call.agent.id)).toEqual([security.id])
    expect(server.store.listTurnAgentRuns(turn.body.workTurnId).map((run) => run.employeeId)).toEqual([security.id])
    expect(server.store.getEmployee(product.id)?.presence).toBe('available')
    expect(server.store.getEmployee(butler.id)?.presence).toBe('available')
  })

  it('persists the semantic speaker plan on the user message so queued execution does not plan again', async () => {
    const { origin, server, world, product, security, butler } = await start()
    const memberIds = [product.id, security.id, butler.id]
    const group = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({ employeeIds: memberIds, collaborationMode: 'discussion' }))
    const turn = await json(origin, `/api/worlds/${world.id}/chat`, post({
      sessionId: group.body.session.id,
      employeeIds: memberIds,
      prompt: '登录偶尔串号，找最合适的人看一下。',
      queueMode: 'normal',
      clientTurnId: 'real-collab-plan-durable',
    }))
    expect(turn.response.status).toBe(202)

    const user = server.store.listMessages(group.body.session.id).find((message) => message.metadata.workTurnId === turn.body.workTurnId && message.kind === 'user')
    expect(user?.metadata.reservationEmployeeIds).toEqual([security.id])
    expect(user?.metadata.groupTurnPlan).toMatchObject({
      source: 'model',
      rationale: '本轮只需要安全专家',
    })
  })

  it('rejects @mentioning a world character who has not joined this group', async () => {
    const { origin, world, product, security, butler } = await start()
    const group = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({
      employeeIds: [product.id, butler.id],
      collaborationMode: 'discussion',
    }))
    const response = await json(origin, `/api/worlds/${world.id}/chat`, post({
      sessionId: group.body.session.id,
      employeeIds: [product.id, butler.id],
      prompt: `@${security.displayName} 帮我看看`,
      queueMode: 'normal',
    }))

    expect(response.response.status).toBe(422)
    expect(response.body.error.code).toBe('mentioned_character_not_in_session')
  })
})
