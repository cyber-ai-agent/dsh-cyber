import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest, EmployeeBlueprint, World } from '@dsh-cyber/contracts'
import { RECOMMENDED_ADMIN_PERMISSIONS } from '@dsh-cyber/contracts/world-authority'

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

async function setAccess(
  origin: string,
  worldId: string,
  employeeId: string,
  permissions: string[],
  role: 'member' | 'administrator' = 'member',
) {
  const result = await json(origin, `/api/worlds/${worldId}/authorities/${employeeId}`, send('PUT', {
    role,
    permissionGrants: permissions,
    reason: 'file-access-test',
  }))
  expect(result.response.status).toBe(200)
}

async function chat(origin: string, worldId: string, employeeId: string, permissionMode?: string) {
  return json(origin, `/api/worlds/${worldId}/chat`, send('POST', {
    prompt: '你好',
    employeeIds: [employeeId],
    ...(permissionMode === undefined ? {} : { permissionMode }),
  }))
}

describe('world file access', () => {
  it('anchors a character without world.files.read at an empty workspace', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, [])
    await chat(origin, world.id, characterId)

    const turn = runtime.turns.at(-1)!
    // With or without the permission the runtime used to receive the same real
    // filesPath, so world.files.read did nothing at all.
    expect(turn.workspacePath).toContain('restricted-workspace')
    expect(await readdir(turn.workspacePath)).toEqual([])
  })

  it('gives a character with world.files.read the real world files, read-only', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, ['world.files.read'])
    await chat(origin, world.id, characterId)

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).toContain(join('worlds'))
    expect(turn.workspacePath).not.toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('read-only')
    await writeFile(join(turn.workspacePath, 'note.md'), '# real\n')
    expect(await readdir(turn.workspacePath)).toContain('note.md')
  })

  it('gives a character with world.files.write the real files and workspace-write', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, ['world.files.read', 'world.files.write'])
    await chat(origin, world.id, characterId, 'workspace-write')

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).not.toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('workspace-write')
  })

  it('passes workspace-write to DSH while keeping a role without world file access in its restricted workspace', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, [])
    await chat(origin, world.id, characterId, 'workspace-write')

    const turn = runtime.turns.at(-1)!
    expect(turn.workspacePath).toContain('restricted-workspace')
    expect(turn.permissionMode).toBe('workspace-write')
    expect(turn.persona).toContain('模式：workspace-write（帮我批准）')
  })

  it('rejects danger-full-access when the current session grant is absent', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, [...RECOMMENDED_ADMIN_PERMISSIONS], 'administrator')
    const result = await chat(origin, world.id, characterId, 'danger-full-access')

    expect(result.response.status).toBe(403)
    expect(result.body.error.code).toBe('owner_runtime_access_denied')
    expect(runtime.turns).toHaveLength(0)
  })

  it('keeps each character in its own sandbox within one world', async () => {
    const { origin, server, runtime, world, characterId } = await start()
    server.store.saveBlueprint(blueprint('writer', '小写'))
    const writer = server.store.recruitEmployee({
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: 'writer',
      blueprintVersion: 1,
    })
    await setAccess(origin, world.id, characterId, [])
    await setAccess(origin, world.id, writer.id, ['world.files.read'])

    await chat(origin, world.id, characterId)
    await chat(origin, world.id, writer.id)

    const denied = runtime.turns.find((turn) => turn.agentId === characterId)!
    const allowed = runtime.turns.find((turn) => turn.agentId === writer.id)!
    expect(denied.workspacePath).not.toBe(allowed.workspacePath)
    expect(denied.workspacePath).toContain('restricted-workspace')
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
    await setAccess(origin, world.id, characterId, [])
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
    await setAccess(origin, world.id, characterId, [...RECOMMENDED_ADMIN_PERMISSIONS], 'administrator')
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
    await setAccess(origin, world.id, characterId, ['world.files.read'])
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
