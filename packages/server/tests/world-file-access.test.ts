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
  readonly turns: Array<{ agentId: string; workspacePath: string; permissionMode?: string }> = []

  async runTurn(request: AgentTurnRequest) {
    this.turns.push({
      agentId: request.agent.id,
      workspacePath: request.workspacePath,
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

  it('never lets a request escalate itself to danger-full-access', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, [...RECOMMENDED_ADMIN_PERMISSIONS], 'administrator')
    await chat(origin, world.id, characterId, 'danger-full-access')

    const turn = runtime.turns.at(-1)!
    // Administrator rights are not host rights. The cap holds regardless of
    // what the client asks for.
    expect(turn.permissionMode).not.toBe('danger-full-access')
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
    const envelopes: Array<{ kind: string; worldId: string }> = []
    // Watch the live stream the client subscribes to.
    const response = await fetch(`${origin}/api/worlds/${world.id}/live`, { headers: { Accept: 'text/event-stream' } })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const read = (async () => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolvePromise) =>
            setTimeout(() => resolvePromise({ done: true, value: undefined }), 600)),
        ])
        if (chunk.done || chunk.value === undefined) break
        for (const line of decoder.decode(chunk.value).split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            const envelope = JSON.parse(line.slice(5).trim()) as { kind?: string; worldId?: string }
            if (envelope.kind !== undefined) envelopes.push({ kind: envelope.kind, worldId: envelope.worldId ?? '' })
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
    await read
    await reader.cancel().catch(() => undefined)

    const decisions = envelopes.filter((item) => item.kind === 'world-decision')
    expect(decisions.length, '决策变化应当被广播').toBeGreaterThan(0)
    void server
  })
})

describe('full host access needs the owner, never the character', () => {
  it('stays capped without a grant even for a world administrator', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, [...RECOMMENDED_ADMIN_PERMISSIONS], 'administrator')
    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '你好',
      employeeIds: [characterId],
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-no-grant',
    }))
    expect(runtime.turns.at(-1)!.permissionMode).not.toBe('danger-full-access')
  })

  it('honours a one-time grant the owner issued for that exact turn', async () => {
    const { origin, runtime, world, characterId } = await start()
    await setAccess(origin, world.id, characterId, ['world.files.read', 'world.files.write'])

    const issued = await json(origin, `/api/worlds/${world.id}/runtime-access-grants`, send('POST', {
      employeeIds: [characterId],
      clientTurnId: 'turn-granted',
      confirmed: true,
    }))
    expect(issued.response.status).toBe(201)

    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '你好',
      employeeIds: [characterId],
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-granted',
      runtimeAccessGrantId: issued.body.grant.id,
    }))
    expect(runtime.turns.at(-1)!.permissionMode).toBe('danger-full-access')

    // The grant is spent: replaying it does not elevate a second turn.
    await json(origin, `/api/worlds/${world.id}/chat`, send('POST', {
      prompt: '再来一次',
      employeeIds: [characterId],
      permissionMode: 'danger-full-access',
      clientTurnId: 'turn-granted',
      runtimeAccessGrantId: issued.body.grant.id,
    }))
    expect(runtime.turns.at(-1)!.permissionMode).not.toBe('danger-full-access')
  })

  it('refuses to issue a grant without an explicit risk confirmation', async () => {
    const { origin, world, characterId } = await start()
    const refused = await json(origin, `/api/worlds/${world.id}/runtime-access-grants`, send('POST', {
      employeeIds: [characterId],
      clientTurnId: 'turn-unconfirmed',
    }))
    expect(refused.response.status).toBe(422)
    expect(refused.body.error.code).toBe('owner_runtime_access_denied')
  })
})
