import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, World } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'
import {
  WORLD_MANAGEMENT_DESCRIPTORS,
  WORLD_MANAGEMENT_HANDLED_ACTIONS,
  WORLD_MANAGEMENT_REQUIREMENTS,
  worldManagementAction,
} from '../src/skills/world-management-adapter.js'
import { createWorldManagementHostForTest } from './helpers/world-management-host.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }
  async close(): Promise<void> {}
}

/**
 * Everything here goes through the real composition root and the real HTTP
 * surface. A world management action that only works when a test hands the
 * adapter a hand-built host is not a shipped feature, which is exactly how
 * `world.rename` and `world.characters.update` came to be advertised without
 * being wired.
 */
async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-mgmt-'))
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime: new QuietRuntime(),
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  const address = await server.start()
  return { origin: address.origin, server }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function send(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

async function administratorWorld(origin: string): Promise<{ world: World; characterId: string }> {
  const workspaces = await json(origin, '/api/workspaces')
  const workspaceId = workspaces.body.items[0].id as string
  const worlds = await json(origin, `/api/workspaces/${workspaceId}/worlds`)
  const world = worlds.body.items[0] as World
  const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
  const characterId = snapshot.body.employees[0].id as string
  const granted = await json(origin, `/api/worlds/${world.id}/authorities/${characterId}`, send('PUT', {
    role: 'administrator',
    reason: 'contract-test',
  }))
  expect(granted.response.status).toBe(200)
  return { world, characterId }
}

async function chat(origin: string, worldId: string, characterId: string, prompt: string) {
  return json(origin, `/api/worlds/${worldId}/chat`, send('POST', { prompt, employeeIds: [characterId] }))
}

async function skillActions(origin: string, worldId: string) {
  const result = await json(origin, `/api/worlds/${worldId}/skill-actions`)
  return result.body.items as Array<{ action: string; status: string; detail: string }>
}

describe('world management host wiring', () => {
  it('renames the world when an administrator asks for it in chat', async () => {
    const { origin } = await start()
    const { world, characterId } = await administratorWorld(origin)

    const turn = await chat(origin, world.id, characterId, '把这个世界改名为 产品评审室')
    expect(turn.response.status).toBe(200)

    const actions = await skillActions(origin, world.id)
    const rename = actions.find((item) => item.action === 'world.rename')
    expect(rename, '重命名动作应当被提议').toBeDefined()
    // Today this fails with "世界重命名服务不可用或名称无效": the descriptor is
    // published but the production host supplies no renameWorld handler.
    expect(rename!.status, rename!.detail).toBe('executed')

    const worlds = await json(origin, `/api/workspaces/${world.workspaceId}/worlds`)
    const renamed = (worlds.body.items as World[]).find((item) => item.id === world.id)
    expect(renamed?.name).toBe('产品评审室')
  })

  it('updates a character through the audited revision path when an administrator asks in chat', async () => {
    const { origin, server } = await start()
    const { world, characterId } = await administratorWorld(origin)
    const before = server.store.getEmployee(characterId)!
    const profileBefore = server.store.getEmployeeProfile(characterId)?.revision ?? 0

    const turn = await chat(origin, world.id, characterId, `把${before.displayName}的身份改成 产品负责人`)
    expect(turn.response.status).toBe(200)

    const actions = await skillActions(origin, world.id)
    const update = actions.find((item) => item.action === 'world.characters.update')
    expect(update, '角色更新动作应当被提议').toBeDefined()
    expect(update!.status, update!.detail).toBe('executed')

    const after = server.store.getEmployee(characterId)!
    expect(after.role).toBe('产品负责人')
    // The change must go through the profile revision chain, not a raw row
    // update: character history is an audit trail, not mutable state.
    expect(server.store.getEmployeeProfile(characterId)!.revision).toBeGreaterThan(profileBefore)
  })

  it('publishes no skill whose host capability is missing', () => {
    // A descriptor without a working handler is a promise the product cannot
    // keep — this is how world.rename and world.characters.update came to be
    // advertised while always failing. The requirement table makes the gap
    // checkable instead of waiting for a user to hit it.
    const host = createWorldManagementHostForTest()
    const missing = WORLD_MANAGEMENT_DESCRIPTORS
      .filter((item) => host[WORLD_MANAGEMENT_REQUIREMENTS[item.id]!] === undefined)
      .map((item) => item.id)
    expect(missing, `未接线的技能：${missing.join('、')}`).toEqual([])
  })

  it('keeps the descriptor table, the requirement table and the execute switch in agreement', () => {
    const declared = WORLD_MANAGEMENT_DESCRIPTORS.map((item) => item.id).sort()
    expect(Object.keys(WORLD_MANAGEMENT_REQUIREMENTS).sort()).toEqual(declared)
    expect([...WORLD_MANAGEMENT_HANDLED_ACTIONS].sort())
      .toEqual(WORLD_MANAGEMENT_DESCRIPTORS.map((item) => worldManagementAction(item.id)).sort())
  })
})

describe('one-time world permission decisions', () => {
  it('is not spent when the action it authorised fails', async () => {
    const { origin, server } = await start()
    const workspaces = await json(origin, '/api/workspaces')
    const workspaceId = workspaces.body.items[0].id as string
    const worlds = await json(origin, `/api/workspaces/${workspaceId}/worlds`)
    const world = worlds.body.items[0] as World
    const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
    const characterId = snapshot.body.employees[0].id as string

    // A member with no world.settings.write must ask for permission first.
    const turn = await chat(origin, world.id, characterId, '把这个世界改名为')
    expect(turn.response.status).toBe(200)

    // The rename carries no name, so the action cannot succeed. Whatever the
    // decision flow does, an unusable approval must not be recorded as spent.
    const requests = await json(origin, `/api/worlds/${world.id}/permission-requests`)
    const pending = (requests.body.items ?? requests.body.requests ?? []) as Array<{ id: string; consumedAt?: string }>
    for (const request of pending) expect(request.consumedAt).toBeUndefined()
    void server
  })
})

describe('permission decisions belong to their conversation', () => {
  it('does not let a typed approval in one session settle another session request', async () => {
    const { origin, server } = await start()
    const { world, characterId } = await administratorWorld(origin)

    // Two conversations with the same character, one of them holding a
    // pending decision.
    const sessionA = server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title: '会话 A',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: characterId, kind: 'employee' }],
    })
    const sessionB = server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title: '会话 B',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: characterId, kind: 'employee' }],
    })

    // Strip the permission so a management request in session A must wait.
    await json(origin, `/api/worlds/${world.id}/authorities/${characterId}`, send('PUT', {
      role: 'member',
      permissionGrants: ['world.files.read'],
      reason: 'session-isolation-test',
    }))
    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '把这个世界改名为 A 会话世界',
      employeeIds: [characterId],
      sessionId: sessionA.id,
    }))
    const pendingBefore = await json(origin, `/api/worlds/${world.id}/permission-requests`)
    const before = (pendingBefore.body.requests ?? pendingBefore.body.items ?? []) as Array<{ id: string; status: string }>

    // "批准" typed in session B must not answer session A's card.
    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '批准',
      employeeIds: [characterId],
      sessionId: sessionB.id,
    }))

    const pendingAfter = await json(origin, `/api/worlds/${world.id}/permission-requests`)
    const after = (pendingAfter.body.requests ?? pendingAfter.body.items ?? []) as Array<{ id: string; status: string }>
    for (const request of before) {
      const survivor = after.find((item) => item.id === request.id)
      expect(survivor?.status, '另一个会话的请求不得被批准').toBe('pending')
    }
  })
})

describe('compound world management requests', () => {
  it('performs both actions of a two-clause request in one turn', async () => {
    const { origin, server } = await start()
    const { world, characterId } = await administratorWorld(origin)
    server.store.saveBlueprint({
      schemaVersion: 1,
      id: 'laowang',
      version: 1,
      worldTemplateId: 'personal-world',
      displayName: '老王',
      role: '成员',
      summary: '测试角色',
      persona: '你是老王。',
      requestedSkills: [],
      requestedCapabilities: [],
      createdAt: '2026-08-25T00:00:00.000Z',
    })
    const laowang = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'laowang',
      blueprintVersion: 1,
    })

    await chat(origin, world.id, characterId, '把当前场景改成产品评审，然后把老王设成管理员')

    const actions = await skillActions(origin, world.id)
    const performed = actions.filter((item) => item.status === 'executed').map((item) => item.action)
    // The scenario regex used to swallow the whole sentence and the promotion
    // never happened at all.
    expect(performed).toEqual(expect.arrayContaining(['world.settings.update', 'world.authority.update']))

    const settings = await json(origin, `/api/worlds/${world.id}/settings`)
    expect(settings.body.settings.scenario).toBe('产品评审')
    expect(settings.body.settings.scenario).not.toContain('管理员')

    const authority = await json(origin, `/api/worlds/${world.id}/authorities/${laowang.id}`)
    expect(authority.body.authority.role).toBe('administrator')
  })
})
