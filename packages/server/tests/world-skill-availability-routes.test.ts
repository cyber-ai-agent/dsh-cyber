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

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '收到', eventCount: 0 }
  }

  async close(): Promise<void> {}
}

async function start(skillAvailability: { isAvailable(input: { skillId: string; worldId: string; workspaceId: string }): boolean | Promise<boolean> }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-skill-availability-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    runtime: new QuietRuntime(),
    bootstrapDefaultWorld: true,
    skillAvailability,
  })
  servers.push(server)
  const address = await server.start()
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  return { origin: address.origin, server, workspace, world }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

describe('World Skill Availability route seam', () => {
  it('defaults only to currently available Blueprint recommendations and honors an explicit empty grant set', async () => {
    const { origin, server, world } = await start({
      isAvailable: ({ skillId }) => skillId !== 'testing',
    })

    const defaultRecruit = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'cyber-company.software-engineer',
      blueprintVersion: 1,
    }))
    expect(defaultRecruit.response.status).toBe(201)
    const defaultRevision = server.store.getEmployeeRevision(defaultRecruit.body.employee.id, 1)!
    expect(defaultRevision.skillGrants).toEqual(['coding'])

    const emptyRecruit = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'cyber-company.software-engineer',
      blueprintVersion: 1,
      skillGrants: [],
    }))
    expect(emptyRecruit.response.status).toBe(201)
    expect(server.store.getEmployeeRevision(emptyRecruit.body.employee.id, 1)?.skillGrants).toEqual([])

    const learnedRecruit = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'cyber-company.software-engineer',
      blueprintVersion: 1,
      skillGrants: ['future.skill'],
    }))
    expect(learnedRecruit.response.status).toBe(201)
    expect(server.store.getEmployeeRevision(learnedRecruit.body.employee.id, 1)?.skillGrants).toEqual(['future.skill'])

    const rejected = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'cyber-company.software-engineer',
      blueprintVersion: 1,
      skillGrants: ['testing'],
    }))
    expect(rejected.response.status).toBe(422)
    expect(rejected.body.error.code).toBe('skill_unavailable_in_world')
  })

  it('retains an existing unavailable grant only when explicitly kept, and permits revocation', async () => {
    let testingAvailable = true
    const { origin, server, world } = await start({
      isAvailable: ({ skillId }) => skillId !== 'testing' || testingAvailable,
    })

    const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({
      blueprintId: 'cyber-company.software-engineer',
      blueprintVersion: 1,
      skillGrants: ['testing'],
    }))
    expect(recruited.response.status).toBe(201)
    const employeeId = recruited.body.employee.id as string
    testingAvailable = false

    const retained = await json(origin, `/api/employees/${employeeId}/revisions`, post({
      reason: '保留历史技能授权',
      skillGrants: ['testing', 'future.skill'],
    }))
    expect(retained.response.status).toBe(201)
    expect(retained.body.revision.skillGrants).toEqual(['testing', 'future.skill'])

    const revoked = await json(origin, `/api/employees/${employeeId}/revisions`, post({
      reason: '撤销当前不可用技能',
      skillGrants: [],
    }))
    expect(revoked.response.status).toBe(201)
    expect(revoked.body.revision.skillGrants).toEqual([])
    expect(server.store.getEmployeeRevision(employeeId, revoked.body.revision.revision)?.skillGrants).toEqual([])
  })
})
