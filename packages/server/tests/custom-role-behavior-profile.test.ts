import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeBlueprint,
  WorldRuntimeSnapshot,
} from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('custom role behavior profile vertical flow', () => {
  it('persists an explicit profile and drives world placement and real tasks', async () => {
    const { server, origin, worldId, employeeId } = await setup()
    const appearance = {
      avatarIndex: 4,
      worldSkinIndex: 4,
      worldBehaviorProfile: quantumGardenerProfile(),
    }

    const saved = await request(origin, `/api/employees/${employeeId}/profile`, {
      method: 'PUT',
      body: JSON.stringify({
        displayName: '星芽',
        background: '负责照看实验植物与异常生长数据。',
        personalityTraits: ['细致', '好奇'],
        appearance,
        reason: '配置自定义岗位空间语义',
      }),
    })
    expect(saved.response.status).toBe(201)
    expect(server.store.getEmployeeProfile(employeeId)?.appearance).toMatchObject(appearance)

    const initial = await request(origin, `/api/worlds/${worldId}/runtime-snapshot`)
    expect(initial.response.status).toBe(200)
    const initialSnapshot = initial.body as WorldRuntimeSnapshot
    const initialEntity = initialSnapshot.entities.find((entity) => entity.id === employeeId)
    expect(initialEntity).toMatchObject({
      displayName: '星芽',
      role: '量子园丁',
      visualState: {
        zoneId: 'zone-research',
      },
    })
    expect(String(initialEntity?.visualState['homeSlotId'])).toMatch(/^work-architecture:slot-/)

    server.store.appendDomainEvent({
      workspaceId: server.store.getWorld(worldId)!.workspaceId,
      worldId,
      type: 'task.started',
      actorId: employeeId,
      actorKind: 'employee',
      payload: {
        employeeId,
        taskId: 'inspect-experimental-crops',
      },
    })

    const working = await request(origin, `/api/worlds/${worldId}/runtime-snapshot`)
    expect(working.response.status).toBe(200)
    const workingSnapshot = working.body as WorldRuntimeSnapshot
    const workingEntity = workingSnapshot.entities.find((entity) => entity.id === employeeId)
    expect(workingEntity?.activity).toBe('working')
    expect(workingEntity?.visualState['zoneId']).toBe('zone-research')
    expect(String(
      workingEntity?.visualState['reservedSlotId']
      ?? workingEntity?.visualState['currentSlotId'],
    )).toMatch(/^work-architecture:slot-/)
  })

  it('rejects malformed semantic profiles without changing persisted appearance', async () => {
    const { server, origin, employeeId } = await setup()
    const before = structuredClone(server.store.getEmployeeProfile(employeeId))
    const rejected = await request(origin, `/api/employees/${employeeId}/profile`, {
      method: 'PUT',
      body: JSON.stringify({
        displayName: '星芽',
        background: '实验园丁。',
        personalityTraits: [],
        appearance: {
          worldBehaviorProfile: {
            ...quantumGardenerProfile(),
            roleTags: ['research', 'research'],
          },
        },
        reason: '提交非法重复标签',
      }),
    })

    expect(rejected.response.status).toBe(422)
    expect(JSON.stringify(rejected.body)).toContain('invalid_character_behavior_profile')
    expect(server.store.getEmployeeProfile(employeeId)).toEqual(before)
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-custom-role-behavior-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    runtime: new QuietRuntime(),
  })
  servers.push(server)
  const workspace = server.store.createWorkspace({ name: '本地工作区' })
  const world = server.store.createWorld({
    workspaceId: workspace.id,
    name: '赛博公司',
    templateId: 'cyber-company',
  })
  server.store.saveBlueprint(customBlueprint())
  const employee = server.store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'user.custom.quantum-gardener',
    blueprintVersion: 1,
    displayName: '星芽',
  })
  const origin = (await server.start()).origin
  return { server, origin, worldId: world.id, employeeId: employee.id }
}

function customBlueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'user.custom.quantum-gardener',
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: '星芽',
    role: '量子园丁',
    summary: '照看实验植物与生长数据。',
    persona: '你是星芽，一名量子园丁。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-22T00:00:00.000Z',
  }
}

function quantumGardenerProfile() {
  return {
    id: 'user.quantum-gardener',
    roleTags: ['botany', 'experiments'],
    preferredZoneTags: ['research'],
    preferredFacilityCapabilities: ['research', 'inspect'],
    allowedZoneTags: ['research', 'meeting', 'rest', 'public'],
    homeSlotTags: ['research', 'work'],
    ambientBehaviors: ['inspect-cultivation-bed'],
    socialPolicy: {
      canInitiateConversation: false,
      cooldownSeconds: 1_800,
      maxDailyConversations: 0,
    },
  }
}

async function request(origin: string, pathname: string, init?: RequestInit) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  return { response, body: await response.json() }
}

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return {
      agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`,
      finalResponse: 'ok',
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}
