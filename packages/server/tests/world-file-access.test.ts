import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint, World } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

/** Records the sandbox each turn was actually given. */
class WorkspaceRecordingRuntime implements AgentRuntimePort {
  readonly turns: Array<{ agentId: string; workspacePath: string; persona: string; permissionMode?: string }> = []

  async runTurn(request: AgentTurnRequest) {
    this.turns.push({
      agentId: request.agent.id,
      workspacePath: request.workspacePath,
      persona: request.revision.persona,
      ...(request.permissionMode === undefined ? {} : { permissionMode: request.permissionMode }),
    })
    return { agentSessionId: `agent-${request.agent.id}`, finalResponse: '好的。', eventCount: 0 }
  }

  async close(): Promise<void> {}
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
    createdAt: '2026-08-25T00:00:00.000Z',
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
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-file-access-'))
  const runtime = new WorkspaceRecordingRuntime()
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  const address = await server.start()
  const workspaces = await json(address.origin, '/api/workspaces')
  const workspaceId = workspaces.body.items[0].id as string
  const worlds = await json(address.origin, `/api/workspaces/${workspaceId}/worlds`)
  const world = worlds.body.items[0] as World

  server.store.saveBlueprint(blueprint('reader', '小读'))
  const character = server.store.recruitEmployee({
    workspaceId,
    worldId: world.id,
    blueprintId: 'reader',
    blueprintVersion: 1,
  })
  return { origin: address.origin, server, runtime, world, characterId: character.id }
}

async function setDefaultPermission(
  origin: string,
  employeeId: string,
  runtimePermissionMode: 'read-only' | 'workspace-write' | 'danger-full-access',
  confirmedFullAccess = false,
) {
  const result = await json(origin, `/api/employees/${employeeId}/revisions`, send('POST', {
    runtimePermissionMode,
    confirmedFullAccess,
    reason: 'runtime-permission-test',
  }))
  expect(result.response.status).toBe(201)
}

async function chat(origin: string, worldId: string, employeeId: string, permissionMode?: string) {
  return json(origin, `/api/worlds/${worldId}/chat`, send('POST', {
    prompt: '你好',
    employeeIds: [employeeId],
    ...(permissionMode === undefined ? {} : { permissionMode }),
  }))
}

/** Grants or revokes a World Permission the way the owner's UI does. */
async function setWorldPermissions(
  origin: string,
  worldId: string,
  employeeId: string,
  permissions: string[],
  role: 'member' | 'administrator' = 'member',
) {
  const result = await json(origin, `/api/worlds/${worldId}/authorities/${employeeId}`, send('PUT', {
    role,
    permissionGrants: permissions,
    reason: 'file-permission-test',
  }))
  expect(result.response.status).toBe(200)
}

describe('the World file permissions the owner can see and toggle', () => {
  it('lets the owner edit permissions in a world that has no administrator', async () => {
    const { origin, world, characterId } = await start()
    const result = await json(origin, `/api/worlds/${world.id}/authorities/${characterId}`, send('PUT', {
      role: 'member',
      permissionGrants: ['world.files.read', 'world.files.write'],
      reason: 'no-administrator-world',
    }))
    // The bootstrapped world has no administrator, and the store refused every
    // authority write in that state — as a generic 500. Only a write that
    // removes the last administrator breaks the invariant.
    expect(result.response.status).toBe(200)
  })

  it('anchors a character whose read permission the owner revoked', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read', 'world.files.write'])
    await setWorldPermissions(origin, world.id, characterId, [])
    await chat(origin, world.id, characterId)

    const turn = runtime.turns.at(-1)!
    // The owner can revoke 读取当前世界文件 in the roster, or say "取消小读的读
    // 文件权限" in chat. It was recorded, audited and reported as done while
    // the runtime kept receiving the world's real files.
    expect(turn.workspacePath).toContain('restricted-workspace')
    expect(await readdir(turn.workspacePath)).toEqual([])
  })

  it('keeps a character whose write permission the owner revoked out of write mode', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setDefaultPermission(origin, characterId, 'workspace-write')
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read', 'world.files.write'])
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read'])
    await chat(origin, world.id, characterId)

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).not.toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('read-only')
  })

  it('restores access when the owner grants the permission back', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read'])
    await setWorldPermissions(origin, world.id, characterId, [])
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read'])
    await chat(origin, world.id, characterId)

    // The ledger still holds the removal. What decides is the current grant.
    expect(runtime.turns.at(-1)!.workspacePath).not.toContain('restricted-workspace')
  })

  it('leaves a character nobody ever said anything about alone', async () => {
    const { origin, server, runtime, world, characterId } = await start()
    // Recruiting has always written an empty grant set, so absence is not a
    // decision. Reading it as one would lock every existing character out of
    // its own world on the first start after an upgrade.
    // Recruiting derives the grants its runtime mode implies, and nothing has
            // ever been taken away.
    expect(server.store.wasWorldCharacterPermissionRevoked(world.id, characterId, 'world.files.read')).toBe(false)
    await chat(origin, world.id, characterId)

    expect(runtime.turns.at(-1)!.workspacePath).not.toContain('restricted-workspace')
  })

  it('takes effect on a session that is already running', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read'])
    await chat(origin, world.id, characterId)
    expect(runtime.turns.at(-1)!.workspacePath).not.toContain('restricted-workspace')

    await setWorldPermissions(origin, world.id, characterId, [])
    await chat(origin, world.id, characterId)

    // A revocation the owner has to restart the app to enforce is not a
    // revocation. The runtime's cwd is fixed when its process starts, so the
    // lane has to be recycled when the workspace changes underneath it.
    expect(runtime.turns.at(-1)!.workspacePath).toContain('restricted-workspace')
  })

  it('does not let a revoked read be escalated around with a host grant', async () => {
    const { origin, server, runtime, world, characterId } = await start()
    const session = server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title: '越权测试',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: characterId, kind: 'employee' }],
    })
    await setWorldPermissions(origin, world.id, characterId, ['world.files.read'])
    await setWorldPermissions(origin, world.id, characterId, [])
    const issued = await json(origin, `/api/worlds/${world.id}/runtime-access-grants`, send('POST', {
      scope: 'session',
      sessionId: session.id,
      employeeIds: [characterId],
      confirmed: true,
    }))
    expect(issued.response.status).toBe(201)

    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '你好',
      employeeIds: [characterId],
      sessionId: session.id,
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-escalate',
      runtimeAccessGrantId: issued.body.grant.id,
    }))

    // Two explicit owner decisions; the one about this world's files is the
    // specific one. Undoing it means granting the permission back.
    expect(runtime.turns.at(-1)!.permissionMode).toBe('read-only')
    expect(runtime.turns.at(-1)!.workspacePath).toContain('restricted-workspace')
  })
})

describe('role runtime access', () => {
  it('defaults a role to read-only in the real World workspace', async () => {
    const { origin, runtime, world, characterId } = await start()
    await chat(origin, world.id, characterId)

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).toContain(join('worlds'))
    expect(turn.workspacePath).not.toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('read-only')
  })

  it('uses the role workspace-write default when the request omits a mode', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setDefaultPermission(origin, characterId, 'workspace-write')
    await chat(origin, world.id, characterId)

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).toContain(join('worlds'))
    expect(turn.workspacePath).not.toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('workspace-write')
    expect(turn.persona).toContain('模式：workspace-write（帮我批准）')
  })

  it('allows a conversation to temporarily choose a safer mode', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setDefaultPermission(origin, characterId, 'workspace-write')
    await chat(origin, world.id, characterId, 'read-only')

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).not.toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('read-only')
  })

  it('rejects danger-full-access when the current session grant is absent', async () => {
    const { origin, runtime, world, characterId } = await start()
    const result = await chat(origin, world.id, characterId, 'danger-full-access')

    expect(result.response.status).toBe(403)
    expect(result.body.error.code).toBe('owner_runtime_access_denied')
    expect(runtime.turns).toHaveLength(0)
  })

  it('keeps role defaults independent inside one world', async () => {
    const { origin, server, runtime, world, characterId } = await start()
    server.store.saveBlueprint(blueprint('writer', '小写'))
    const writer = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'writer',
      blueprintVersion: 1,
    })
    await setDefaultPermission(origin, characterId, 'read-only')
    await setDefaultPermission(origin, writer.id, 'workspace-write')

    await chat(origin, world.id, characterId)
    await chat(origin, world.id, writer.id)

    const denied = runtime.turns.find((turn) => turn.agentId === characterId)!
    const allowed = runtime.turns.find((turn) => turn.agentId === writer.id)!
    expect(denied.workspacePath).toBe(allowed.workspacePath)
    expect(denied.permissionMode).toBe('read-only')
    expect(allowed.permissionMode).toBe('workspace-write')
  })
})

describe('pending decisions are announced, not polled for', () => {
  it('publishes a decision envelope on change and none per streamed token', async () => {
    const { origin, server, world, characterId } = await start()
    const envelopes: Array<{
      kind: string
      worldId: string
      payload?: { requestId?: string; status?: string }
    }> = []
    let targetRequestId: string | undefined
    // Watch the live stream the client subscribes to.
    const response = await fetch(`${origin}/api/worlds/${world.id}/live`, { headers: { Accept: 'text/event-stream' } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const read = (async () => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline && !envelopes.some((item) => item.payload?.requestId === targetRequestId && item.payload.status === 'rejected')) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ timedOut: true }>((resolvePromise) =>
            setTimeout(() => resolvePromise({ timedOut: true }), 600)),
        ])
        if ('timedOut' in chunk) continue
        if (chunk.done || chunk.value === undefined) break
        for (const line of decoder.decode(chunk.value).split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const envelope = JSON.parse(line.slice(5).trim()) as {
              kind?: string
              worldId?: string
              payload?: { requestId?: string; status?: string }
            }
            if (envelope.kind !== undefined) {
              envelopes.push({ kind: envelope.kind, worldId: envelope.worldId ?? '', payload: envelope.payload })
            }
          } catch {
            // Non-JSON keep-alive lines.
          }
        }
      }
    })()

    // A member asking for a management action creates a pending decision.
    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '把这个世界改名为 通知测试世界',
      employeeIds: [characterId],
    }))
    const pending = await json(origin, `/api/worlds/${world.id}/permission-requests`)
    const request = (pending.body.permissionRequests ?? pending.body.requests ?? [])[0] as { id?: string } | undefined
    expect(request?.id, '应当创建待处理的世界权限请求').toBeDefined()
    targetRequestId = request!.id
    const rejected = await json(origin, `/api/world-permission-requests/${request!.id}/decision`, send('POST', { decision: 'reject' }))
    expect(rejected.response.status).toBe(200)
    await read
    await reader.cancel().catch(() => undefined)

    const decisions = envelopes.filter((item) => item.kind === 'world-decision')
    expect(decisions.some((item) => item.payload?.requestId === request!.id && item.payload.status === 'pending'), '创建决策应当被广播').toBe(true)
    expect(decisions.some((item) => item.payload?.requestId === request!.id && item.payload.status === 'rejected'), '拒绝决策也应当被广播').toBe(true)
    void server
  })
})

describe('full host access needs the owner, never the character', () => {
  it('returns an explicit authorization error without a session grant', async () => {
    const { origin, runtime, world, characterId } = await start()
    const refused = await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '你好',
      employeeIds: [characterId],
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-no-grant',
    }))
    expect(refused.response.status).toBe(403)
    expect(refused.body.error.code).toBe('owner_runtime_access_denied')
    expect(runtime.turns).toHaveLength(0)
  })

  it('keeps a confirmed full-access grant active for the current session', async () => {
    const { origin, server, runtime, world, characterId } = await start()
    const session = server.store.createSession({ workspaceId: world.workspaceId, worldId: world.id, kind: 'direct', title: '完整访问测试', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: characterId, kind: 'employee' }] })

    const issued = await json(origin, `/api/worlds/${world.id}/runtime-access-grants`, send('POST', {
      scope: 'session',
      sessionId: session.id,
      employeeIds: [characterId],
      confirmed: true,
    }))
    expect(issued.response.status).toBe(201)

    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '你好',
      employeeIds: [characterId],
      sessionId: session.id,
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-granted-1',
      runtimeAccessGrantId: issued.body.grant.id,
    }))
    expect(runtime.turns.at(-1)!.permissionMode).toBe('danger-full-access')
    expect(runtime.turns.at(-1)!.persona).toContain('模式：danger-full-access（完全访问）')
    expect(runtime.turns.at(-1)!.persona).toContain('用户已为当前会话和当前角色完成高风险确认')

    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '再来一次',
      employeeIds: [characterId],
      sessionId: session.id,
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-granted-2',
      runtimeAccessGrantId: issued.body.grant.id,
    }))
    expect(runtime.turns.slice(-2).every((turn) => turn.permissionMode === 'danger-full-access')).toBe(true)
  })

  it('refuses to issue a grant without an explicit risk confirmation', async () => {
    const { origin, server, world, characterId } = await start()
    const session = server.store.createSession({ workspaceId: world.workspaceId, worldId: world.id, kind: 'direct', title: '拒绝授权测试', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: characterId, kind: 'employee' }] })
    const refused = await json(origin, `/api/worlds/${world.id}/runtime-access-grants`, send('POST', {
      scope: 'session',
      sessionId: session.id,
      employeeIds: [characterId],
      confirmed: false,
    }))
    expect(refused.response.status).toBe(422)
    expect(refused.body.error.code).toBe('owner_runtime_access_denied')
  })

  it('refuses to issue a grant for a role outside the bound conversation', async () => {
    const { origin, server, world, characterId } = await start()
    server.store.saveBlueprint(blueprint('outsider', '会话外角色'))
    const outsider = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'outsider',
      blueprintVersion: 1,
    })
    const session = server.store.createSession({
      workspaceId: world.workspaceId,
      worldId: world.id,
      kind: 'direct',
      title: '成员绑定测试',
      participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: characterId, kind: 'employee' }],
    })

    const refused = await json(origin, `/api/worlds/${world.id}/runtime-access-grants`, send('POST', {
      scope: 'session',
      sessionId: session.id,
      employeeIds: [outsider.id],
      confirmed: true,
    }))
    expect(refused.response.status).toBe(422)
    expect(refused.body.error.code).toBe('session_participant_mismatch')
  })
})
