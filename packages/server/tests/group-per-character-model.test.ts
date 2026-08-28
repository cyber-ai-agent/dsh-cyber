import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint, World } from '@dsh-cyber/contracts'
import type { GroupTurnPlan, GroupTurnPlannerPort } from '@dsh-cyber/orchestration'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/** Records the model each character's turn was actually routed to. */
class ModelRecordingRuntime implements AgentRuntimePort {
  readonly turns: Array<{ agentId: string; modelProfileId?: string }> = []

  async runTurn(request: AgentTurnRequest) {
    this.turns.push({
      agentId: request.agent.id,
      ...(request.modelProfileId === undefined ? {} : { modelProfileId: request.modelProfileId }),
    })
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '收到。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

/** Keeps the roster whole so the test measures routing, not planning. */
const everyone: GroupTurnPlannerPort = {
  async plan(input): Promise<GroupTurnPlan> {
    return { source: 'explicit', waves: [{ speakers: input.candidates.map((item) => ({ employeeId: item.employeeId })) }] }
  },
}

function blueprint(id: string, displayName: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'personal-world',
    displayName,
    role: '成员',
    summary: '测试角色',
    persona: `你是${displayName}。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-27T00:00:00.000Z',
  }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-group-model-'))
  const runtime = new ModelRecordingRuntime()
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    bootstrapDefaultWorld: true,
    groupTurnPlanner: everyone,
  })
  servers.push(server)
  const address = await server.start()
  const workspaces = await json(address.origin, '/api/workspaces')
  const workspaceId = workspaces.body.items[0].id as string
  const worlds = await json(address.origin, `/api/workspaces/${workspaceId}/worlds`)
  const world = worlds.body.items[0] as World

  const employees = [['architect', '老王'], ['product', '小刘']].map(([id, displayName]) => {
    server.store.saveBlueprint(blueprint(id!, displayName!))
    return server.store.recruitEmployee({ workspaceId, worldId: world.id, blueprintId: id!, blueprintVersion: 1 })
  })

  const profile = (displayName: string, modelId: string) => server.store.saveModelProfile({
    workspaceId,
    displayName,
    providerKind: 'openai-compatible-remote',
    baseUrl: 'https://models.example.com/v1',
    modelId,
    api: 'openai-completions',
  })

  return {
    origin: address.origin,
    server,
    runtime,
    world,
    workspaceId,
    employees,
    fast: profile('快模型', 'fast-model'),
    deep: profile('深模型', 'deep-model'),
  }
}

describe('a group turn routes each character to its own model', () => {
  it('carries a per-character model map from the request to the runtime', async () => {
    const { origin, runtime, world, employees, fast, deep } = await start()

    const chat = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '一起看下这个方案',
      employeeIds: employees.map((employee) => employee.id),
      modelProfileIds: {
        [employees[0]!.id]: deep.id,
        [employees[1]!.id]: fast.id,
      },
    }))
    expect(chat.response.status).toBe(200)

    const routed = new Map(runtime.turns.map((turn) => [turn.agentId, turn.modelProfileId]))
    // The composer used to send one scalar for the whole turn, so every
    // character in the room ran on whichever model was selected.
    expect(routed.get(employees[0]!.id)).toBe(deep.id)
    expect(routed.get(employees[1]!.id)).toBe(fast.id)
  })

  it('leaves a character with no entry to its own assignment', async () => {
    const { origin, runtime, world, workspaceId, employees, deep, server } = await start()
    server.store.saveModelAssignment({ workspaceId, scope: 'employee', scopeId: employees[1]!.id, modelProfileId: deep.id })

    const chat = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '一起看下这个方案',
      employeeIds: employees.map((employee) => employee.id),
      modelProfileIds: { [employees[0]!.id]: deep.id },
    }))
    expect(chat.response.status).toBe(200)

    const routed = new Map(runtime.turns.map((turn) => [turn.agentId, turn.modelProfileId]))
    // Undefined at this layer is what lets resolveModelProfile fall through to
    // the character's own employee-scope assignment.
    expect(routed.get(employees[1]!.id)).toBeUndefined()
  })

  it('refuses a model that belongs to another workspace', async () => {
    const { origin, world, employees, server } = await start()
    const other = server.store.createWorkspace({ name: '另一个工作区' })
    const foreign = server.store.saveModelProfile({
      workspaceId: other.id,
      displayName: '别人的模型',
      providerKind: 'openai-compatible-remote',
      baseUrl: 'https://elsewhere.example.com/v1',
      modelId: 'foreign-model',
      api: 'openai-completions',
    })

    const chat = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '一起看下这个方案',
      employeeIds: employees.map((employee) => employee.id),
      modelProfileIds: { [employees[0]!.id]: foreign.id },
    }))

    expect(chat.response.status).toBe(422)
    expect(chat.body.error.code).toBe('conversation_model_unavailable')
  })

  it('refuses a model aimed at a character outside this turn', async () => {
    const { origin, world, employees, fast } = await start()

    const chat = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '一起看下这个方案',
      employeeIds: employees.map((employee) => employee.id),
      modelProfileIds: { 'not-in-this-turn': fast.id },
    }))

    expect(chat.response.status).toBe(422)
    expect(chat.body.error.code).toBe('conversation_model_unavailable')
  })
})
