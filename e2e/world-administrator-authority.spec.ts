import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import {
  createCyberServer,
  WorldCharacterAuthorityService,
  WorldRuntimePermissionResolver,
  type CyberServer,
} from '../packages/server/lib/index.js'
import { WorldRootService } from '../packages/server/lib/services/world-root-service.js'

let server: CyberServer
let origin: string
let stateRoot: string
let primaryWorkspaceId: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-authority-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new QuietBrowserRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('keeps World authority isolated, supports multi-admin handoff, and caps runtime access', async ({ page }) => {
  const workspace = await createWorkspace('World Authority E2E')
  primaryWorkspaceId = workspace.id
  const firstWorld = await createWorld(workspace.id, 'Authority World')
  const firstAdmin = await recruit(firstWorld.id, 'core.butler', '管家')
  const secondRole = await recruit(firstWorld.id, 'core.butler', '工程师')
  const secondWorld = await createWorld(workspace.id, 'Other World')
  const foreignRole = await recruit(secondWorld.id, 'core.butler', '外部角色')

  const initial = await getAuthorities(firstWorld.id)
  expect(initial).toHaveLength(2)
  expect(initial.find((authority) => authority.employeeId === firstAdmin.id)?.role).toBe('administrator')
  expect(initial.find((authority) => authority.employeeId === secondRole.id)?.role).toBe('member')

  const promoted = await request(`/api/worlds/${firstWorld.id}/authorities/${secondRole.id}`, {
    method: 'PUT',
    body: { role: 'administrator', reason: '补充当前世界管理员' },
  })
  expect(promoted.status).toBe(200)
  expect(promoted.body.authority.role).toBe('administrator')
  expect(promoted.body.authority.permissionGrants).toContain('world.permissions.manage')

  const demoted = await request(`/api/worlds/${firstWorld.id}/authorities/${secondRole.id}`, {
    method: 'PUT',
    body: { role: 'member', permissionGrants: ['world.files.read', 'world.files.write'], reason: '回收管理职责' },
  })
  expect(demoted.status).toBe(200)
  expect(demoted.body.authority.role).toBe('member')
  expect(demoted.body.authority.permissionGrants).toEqual(['world.files.read', 'world.files.write'])

  const lastAdmin = await request(`/api/worlds/${firstWorld.id}/authorities/${firstAdmin.id}`, {
    method: 'PUT',
    body: { role: 'member', permissionGrants: ['world.files.read'], reason: '不能移除最后管理员' },
  })
  expect(lastAdmin.status).toBe(409)
  expect(lastAdmin.body.error?.code).toBe('last_world_administrator')

  await request(`/api/worlds/${firstWorld.id}/authorities/${secondRole.id}`, {
    method: 'PUT',
    body: { role: 'administrator', reason: '先完成管理员移交' },
  })
  const handoff = await request(`/api/worlds/${firstWorld.id}/authorities/${firstAdmin.id}`, {
    method: 'PUT',
    body: { role: 'member', permissionGrants: ['world.files.read'], reason: '完成管理员移交' },
  })
  expect(handoff.status).toBe(200)
  const finalAuthorities = await getAuthorities(firstWorld.id)
  expect(finalAuthorities.filter((authority) => authority.role === 'administrator').map((authority) => authority.employeeId)).toEqual([secondRole.id])

  const crossWorld = await request(`/api/worlds/${firstWorld.id}/authorities/${foreignRole.id}`, {
    method: 'PUT',
    body: { role: 'administrator', reason: '跨世界应该拒绝' },
  })
  expect(crossWorld.status).toBe(403)
  expect(crossWorld.body.error?.code).toBe('cross_world_authority')

  const authority = new WorldCharacterAuthorityService(server.store)
  const resolver = new WorldRuntimePermissionResolver({
    roots: new WorldRootService(stateRoot),
    authority,
  })
  const administratorRuntime = await resolver.resolve({
    worldId: firstWorld.id,
    employeeId: secondRole.id,
    requestedMode: 'danger-full-access',
  })
  expect(administratorRuntime.permissionMode).toBe('workspace-write')
  expect(administratorRuntime.workspacePath).toContain(join('worlds', encodeURIComponent(firstWorld.id), 'files'))
  const memberRuntime = await resolver.resolve({
    worldId: firstWorld.id,
    employeeId: firstAdmin.id,
    requestedMode: 'workspace-write',
  })
  expect(memberRuntime.permissionMode).toBe('read-only')

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.locator('.avatar .authority-badge')).toHaveCount(0)
  await expect(page.locator('.session-row__copy .authority-badge').first()).toBeVisible()
  const pendingUrls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(`/api/worlds/${firstWorld.id}/`)
      && (request.url().includes('/pending-decisions') || request.url().includes('/permission-requests'))) {
      pendingUrls.push(request.url())
    }
  })
  await page.reload()
  await expect.poll(() => pendingUrls.length).toBeGreaterThan(0)
  expect(pendingUrls.every((url) => url.includes('/pending-decisions'))).toBe(true)
})

test('protects World settings with an expected revision', async () => {
  const workspace = await createWorkspace('Settings Revision E2E')
  const world = await createWorld(workspace.id, 'Revision World')
  await recruit(world.id, 'core.butler', '管家')
  const initial = await request(`/api/worlds/${world.id}/settings`)
  expect(initial.status).toBe(200)
  expect(typeof initial.body.revision).toBe('number')

  const saved = await request(`/api/worlds/${world.id}/settings`, {
    method: 'PUT',
    body: { expectedRevision: initial.body.revision, scenario: '第一次设置' },
  })
  expect(saved.status).toBe(200)
  expect(saved.body.revision).toBe(initial.body.revision + 1)

  const conflict = await request(`/api/worlds/${world.id}/settings`, {
    method: 'PUT',
    body: { expectedRevision: initial.body.revision, scenario: '覆盖应该被拒绝' },
  })
  expect(conflict.status).toBe(409)
  expect(conflict.body.error?.code).toBe('world_settings_revision_conflict')
})

test('continues the same WorkTurn after inline and chat-text permission decisions', async ({ page }) => {
  const world = await createWorld(primaryWorkspaceId, 'Continuation World')
  await recruit(world.id, 'core.butler', '管家')
  const member = await recruit(world.id, 'core.butler', '小刘')

  const first = await request(`/api/worlds/${world.id}/chat`, {
    method: 'POST',
    body: { prompt: '把当前场景改成风暴控制室', employeeIds: [member.id], permissionMode: 'read-only' },
  })
  expect(first.status).toBe(200)
  expect(first.body.waitingForApproval).toBe(true)
  const firstTurnId = first.body.workTurnId as string
  const pending = await request(`/api/worlds/${world.id}/pending-decisions`)
  expect(pending.status).toBe(200)
  expect(pending.body.permissionRequests).toHaveLength(1)
  expect(pending.body.permissionRequests[0].workTurnId).toBe(firstTurnId)

  const inlineDecision = await request(`/api/world-permission-requests/${pending.body.permissionRequests[0].id}/decision`, {
    method: 'POST',
    body: { decision: 'once' },
  })
  expect(inlineDecision.status).toBe(200)
  expect(inlineDecision.body.continuation, JSON.stringify(inlineDecision.body)).toBeDefined()
  expect(inlineDecision.body.continuation.workTurnId).toBe(firstTurnId)
  expect(server.store.getWorkTurn(firstTurnId)?.status).toBe('completed')

  const second = await request(`/api/worlds/${world.id}/chat`, {
    method: 'POST',
    body: {
      prompt: '把世界观改成深海科研站',
      employeeIds: [member.id],
      sessionId: first.body.session.id,
      permissionMode: 'read-only',
    },
  })
  expect(second.status).toBe(200)
  expect(second.body.waitingForApproval).toBe(true)
  const secondTurnId = second.body.workTurnId as string
  const textDecision = await request(`/api/worlds/${world.id}/chat`, {
    method: 'POST',
    body: {
      prompt: '批准',
      employeeIds: [member.id],
      sessionId: first.body.session.id,
      permissionMode: 'read-only',
    },
  })
  expect(textDecision.status).toBe(200)
  expect(textDecision.body.workTurnId).toBe(secondTurnId)
  expect(textDecision.body.session.id).toBe(first.body.session.id)
  expect(server.store.getWorkTurn(secondTurnId)?.status).toBe('completed')

  const settings = await request(`/api/worlds/${world.id}/settings`)
  expect(settings.body.settings.scenario).toBe('风暴控制室')
  expect(settings.body.settings.lore).toBe('深海科研站')

  await page.goto(origin)
  await page.getByLabel(/切换世界，当前为/).click()
  await page.getByRole('menuitemradio', { name: /Continuation World/ }).click()
  await page.getByRole('button', { name: '与小刘私聊' }).click()
  const composer = page.getByRole('textbox', { name: /给当前世界的.+发送消息/ })
  const chatResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/worlds/${world.id}/chat`)
      && response.request().method() === 'POST')
  await composer.fill('把当前场景改成星港议事厅')
  await composer.press('Enter')
  const browserChatResponse = await chatResponsePromise
  expect(browserChatResponse.status()).toBe(202)
  const browserChat = await browserChatResponse.json() as any
  expect(browserChat.queueItem?.workTurnId).toBe(browserChat.workTurnId)
  await expect(page.locator('[aria-label="待处理的世界权限请求"]')).toBeVisible()

  const decisionResponsePromise = page.waitForResponse((response) =>
    response.url().includes('/api/world-permission-requests/')
      && response.url().endsWith('/decision')
      && response.request().method() === 'POST')
  await page.getByRole('button', { name: '仅本次允许', exact: true }).click()
  const browserDecision = await (await decisionResponsePromise).json() as any
  expect(browserDecision.continuation.workTurnId).toBe(browserChat.workTurnId)
  await expect(page.locator('[aria-label="待处理的世界权限请求"]')).toBeHidden()
  await expect.poll(async () => {
    const latest = await request(`/api/worlds/${world.id}/settings`)
    return latest.body.settings.scenario
  }).toBe('星港议事厅')
})

async function createWorkspace(name: string): Promise<{ id: string }> {
  const result = await request('/api/workspaces', { method: 'POST', body: { name } })
  expect(result.status).toBe(201)
  return result.body.workspace as { id: string }
}

async function createWorld(workspaceId: string, name: string): Promise<{ id: string }> {
  const result = await request(`/api/workspaces/${workspaceId}/worlds`, {
    method: 'POST',
    body: { name, templateId: 'personal-world' },
  })
  expect(result.status).toBe(201)
  return result.body.world as { id: string }
}

async function recruit(worldId: string, blueprintId: string, displayName: string): Promise<{ id: string }> {
  const result = await request(`/api/worlds/${worldId}/recruit`, {
    method: 'POST',
    body: { blueprintId, blueprintVersion: 1, displayName },
  })
  expect(result.status).toBe(201)
  return result.body.employee as { id: string }
}

async function getAuthorities(worldId: string): Promise<Array<{ employeeId: string; role: string; permissionGrants: string[] }>> {
  const result = await request(`/api/worlds/${worldId}/authorities`)
  expect(result.status).toBe(200)
  return result.body.authorities as Array<{ employeeId: string; role: string; permissionGrants: string[] }>
}

async function request(path: string, options: { method?: string; body?: Record<string, unknown> } = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const body = await response.json() as any
  return { status: response.status, body }
}

class QuietBrowserRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return {
      agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`,
      finalResponse: 'ok',
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}
