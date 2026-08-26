import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { openDockTab } from './dock-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-skill-catalog-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: new CatalogBrowserRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('uses real world Catalog, revision persistence, availability gates and an approval-backed SkillAction', async ({ page }) => {
  const consoleIssues: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(`[console:${message.type()}] ${message.text()}`)
  })
  page.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`))
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const worldA = current.store.listWorlds(workspace.id)[0]!
  const employee = current.store.listEmployees(worldA.id)[0]!

  const worldB = await createWorld('技能隔离世界')
  const market = await getJson<{ items: Array<{ manifest: { id: string; version: string } }> }>(`${origin}/api/marketplace?market=plugin`)
  const firecrawl = market.items.find((item) => item.manifest.id === 'official-firecrawl-search')
  expect(firecrawl).toBeDefined()
  const preview = await postJson<{ preview: { approvalToken: string } }>(`${origin}/api/workspaces/${workspace.id}/marketplace/preview`, {
    packageId: firecrawl!.manifest.id,
    version: firecrawl!.manifest.version,
  })
  expect(preview.status, JSON.stringify(preview.body)).toBe(200)
  const install = await postJson(`${origin}/api/workspaces/${workspace.id}/marketplace/install`, {
    packageId: firecrawl!.manifest.id,
    version: firecrawl!.manifest.version,
    approvalToken: preview.body.preview.approvalToken,
    worldId: worldA.id,
  })
  expect(install.status, JSON.stringify(install.body)).toBe(201)

  const worldCatalogA = await getJson<{ items: Array<{ id: string; worldAvailable: boolean; availability: string }> }>(`${origin}/api/worlds/${worldA.id}/skill-catalog`)
  const worldCatalogB = await getJson<{ items: Array<{ id: string; worldAvailable: boolean; availability: string }> }>(`${origin}/api/worlds/${worldB.id}/skill-catalog`)
  expect(worldCatalogA.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'web.search.firecrawl', worldAvailable: true, availability: 'available' })]))
  expect(worldCatalogB.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'web.search.firecrawl', worldAvailable: false, availability: 'unavailable' })]))
  expect(current.store.listWorldPackageInstances(worldA.id, 'active')).toEqual(expect.arrayContaining([expect.objectContaining({ packageId: firecrawl!.manifest.id })]))
  expect(current.store.listWorldPackageInstances(worldB.id, 'active')).toHaveLength(0)

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await dock.getByRole('article').first().getByRole('button', { name: `管理${employee.displayName}` }).click()
  const management = page.getByRole('dialog', { name: new RegExp(`角色设置 · ${employee.displayName}`) })
  await management.getByRole('tab', { name: '技能与工具' }).click()
  const firecrawlGrant = management.locator('.skill-grant-row').filter({ hasText: '联网搜索' }).getByRole('checkbox')
  await expect(firecrawlGrant).toBeVisible()
  await expect(firecrawlGrant).toBeEnabled()
  await firecrawlGrant.check()
  const screenshotRoot = join(process.cwd(), 'artifacts', 'skill-catalog-character-learning')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(management).toBeVisible()
    expect(await management.evaluate((element) => ({
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      readableText: Array.from(element.querySelectorAll('button, input, label, small, em')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12),
      usableControls: element.querySelectorAll('.skill-grant-row').length > 0 && Array.from(element.querySelectorAll('.skill-grant-row')).every((item) => item.getBoundingClientRect().height >= 40),
    }))).toEqual({ noHorizontalOverflow: true, readableText: true, usableControls: true })
    await page.screenshot({ path: join(screenshotRoot, `skill-catalog-${viewport.label}.png`), fullPage: false })
  }
  await management.getByRole('button', { name: '保存能力设置' }).click()
  await expect(management).toBeHidden()

  const savedRevision = current.store.getEmployeeRevision(employee.id, current.store.getEmployee(employee.id)!.currentRevision)
  expect(savedRevision?.skillGrants).toContain('web.search.firecrawl')
  const persistedDossier = await getJson<{ revisions: Array<{ skillGrants: string[] }> }>(`${origin}/api/employees/${employee.id}/dossier`)
  expect(persistedDossier.revisions.at(-1)?.skillGrants).toContain('web.search.firecrawl')

  await page.reload()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '角色')
  await page.getByRole('region', { name: '世界与角色侧边栏' }).getByRole('article').first().getByRole('button', { name: `管理${employee.displayName}` }).click()
  const refreshedManagement = page.getByRole('dialog', { name: new RegExp(`角色设置 · ${employee.displayName}`) })
  await refreshedManagement.getByRole('tab', { name: '技能与工具' }).click()
  await expect(refreshedManagement.locator('.skill-grant-row').filter({ hasText: '联网搜索' }).getByRole('checkbox')).toBeChecked()
  await refreshedManagement.getByRole('button', { name: '关闭角色设置' }).click()

  const worldBRecruit = await postJson<{ employee: { id: string } }>(`${origin}/api/worlds/${worldB.id}/recruit`, {
    blueprintId: employee.blueprintId,
    blueprintVersion: employee.blueprintVersion,
    displayName: '隔离管家',
  })
  expect(worldBRecruit.status, JSON.stringify(worldBRecruit.body)).toBe(201)
  const deniedRevision = await postJson(`${origin}/api/employees/${worldBRecruit.body.employee.id}/revisions`, {
    reason: '验证世界目录不可用拒绝',
    skillGrants: ['web.search.firecrawl'],
    capabilityGrants: [],
    modelPolicy: {},
  })
  expect(deniedRevision.status, JSON.stringify(deniedRevision.body)).toBe(422)

  const chat = await postJson(`${origin}/api/worlds/${worldA.id}/chat`, {
    employeeIds: [employee.id],
    clientTurnId: `skill-catalog-e2e-${Date.now()}`,
    prompt: '请联网搜索：本地优先应用的最新公开资料',
  })
  expect(chat.status, JSON.stringify(chat.body)).toBe(200)
  await expect.poll(async () => (await getJson<{ items: Array<{ skillId: string; status: string; approvalRequestId?: string }> }>(`${origin}/api/worlds/${worldA.id}/skill-actions`)).items).toEqual(expect.arrayContaining([expect.objectContaining({ skillId: 'web.search.firecrawl', status: 'waiting-for-approval', approvalRequestId: expect.any(String) })]))
  const pendingAction = current.store.listWorldSkillActions(worldA.id).at(-1)
  expect(pendingAction?.status).toBe('waiting-for-approval')
  expect(pendingAction?.executionState).toBeUndefined()
  await writeFile(join(process.cwd(), 'artifacts', 'skill-catalog-character-learning', 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function createWorld(name: string): Promise<{ id: string }> {
  const workspace = requireServer().store.listWorkspaces()[0]!
  const response = await postJson<{ world: { id: string } }>(`${origin}/api/workspaces/${workspace.id}/worlds`, { name, templateId: 'personal-world' })
  expect(response.status, JSON.stringify(response.body)).toBe(201)
  return response.body.world
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json() as unknown
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`)
  return body as T
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('技能目录 E2E 服务尚未启动')
  return server
}

class CatalogBrowserRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: '已安全等待审批。', eventCount: 0 }
  }

  async close(): Promise<void> {}
}
