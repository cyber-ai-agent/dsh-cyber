import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-ssh-conversational-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: new SilentRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('drives SSH from natural conversation once the skill and device are granted', async () => {
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!

  // 1) Add an SSH device with a password through the public integration API.
  const added = await putJson<{ connection: { id: string; displayName: string } }>(
    `/api/workspaces/${workspace.id}/integrations/builtin.ssh-device`,
    {
      config: { displayName: '客厅主机', host: '10.0.0.10', port: 22, username: 'owner' },
      enabled: true,
      secrets: { password: 'e2e-not-real-password' },
    },
  )
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  const deviceId = added.body.connection.id

  // 2) Recruit an operator and grant the SSH skill.
  const recruited = await postJson<{ employee: { id: string } }>(`/api/worlds/${world.id}/recruit`, {
    blueprintId: 'cyber-company.software-engineer',
    blueprintVersion: 1,
    displayName: `运维-${Date.now().toString(36)}`,
    skillGrants: ['device.ssh.command'],
  })
  expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
  const employeeId = recruited.body.employee.id

  // 3) Grant the connection to this character (second half of the two-level gate).
  const granted = await postJson(`/api/employees/${employeeId}/revisions`, {
    reason: '授权连接中心设备',
    connectionGrants: [deviceId],
  })
  expect(granted.status, JSON.stringify(granted.body)).toBe(201)

  // 4) Natural conversation with the device named -> proposal waiting approval.
  const chat = await postJson(`/api/worlds/${world.id}/chat`, {
    employeeIds: [employeeId],
    clientTurnId: `ssh-natural-${Date.now()}`,
    prompt: '连客厅主机看看磁盘',
  })
  expect(chat.status, JSON.stringify(chat.body)).toBe(200)
  await expect.poll(async () => (await getJson<{ items: Array<{ skillId: string; action: string; status: string }> }>(`/api/worlds/${world.id}/skill-actions`)).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ skillId: 'device.ssh.command', action: 'ssh.disk.usage', status: 'waiting-for-approval' })]),
  )

  // 5) With a single granted device the user does not need to name it.
  const bare = await postJson(`/api/worlds/${world.id}/chat`, {
    employeeIds: [employeeId],
    clientTurnId: `ssh-bare-${Date.now()}`,
    prompt: '看看内存占用',
  })
  expect(bare.status, JSON.stringify(bare.body)).toBe(200)
  await expect.poll(async () => (await getJson<{ items: Array<{ action: string; status: string }> }>(`/api/worlds/${world.id}/skill-actions`)).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ action: 'ssh.memory.usage', status: 'waiting-for-approval' })]),
  )

  // 6) A character that only has the skill but no granted device must not
  //    produce a device action.
  const noGrant = await postJson<{ employee: { id: string } }>(`/api/worlds/${world.id}/recruit`, {
    blueprintId: 'cyber-company.software-engineer',
    blueprintVersion: 1,
    displayName: `无授权-${Date.now().toString(36)}`,
    skillGrants: ['device.ssh.command'],
  })
  expect(noGrant.status, JSON.stringify(noGrant.body)).toBe(201)
  const noGrantId = noGrant.body.employee.id
  const chatNoGrant = await postJson(`/api/worlds/${world.id}/chat`, {
    employeeIds: [noGrantId],
    clientTurnId: `ssh-nogrant-${Date.now()}`,
    prompt: '看看磁盘',
  })
  expect(chatNoGrant.status, JSON.stringify(chatNoGrant.body)).toBe(200)
  // Give the pipeline a moment; then confirm no ssh action was reserved for them.
  await new Promise((resolve) => setTimeout(resolve, 400))
  const actions = await getJson<{ items: Array<{ characterId: string; skillId: string }> }>(`/api/worlds/${world.id}/skill-actions`)
  expect(actions.items.some((item) => item.characterId === noGrantId && item.skillId === 'device.ssh.command')).toBe(false)
})

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`)
  const body = await response.json() as unknown
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${JSON.stringify(body)}`)
  return body as T
}

async function postJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

async function putJson<T = unknown>(path: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('SSH 对话 E2E 服务尚未启动')
  return server
}

class SilentRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: '已记录请求。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}
