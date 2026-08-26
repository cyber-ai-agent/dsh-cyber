import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import {
  createCyberServer,
  type BrowserClient,
  type BrowserClientFactory,
  BrowserPolicy,
  type BrowserResolvedTarget,
  type CyberServer,
} from '../packages/server/lib/index.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
let browserFactory: RecordingBrowserFactory
let runtime: FactualBrowserRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-browser-permission-e2e-'))
  browserFactory = new RecordingBrowserFactory()
  runtime = new FactualBrowserRuntime()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
    browserClientFactory: browserFactory,
    browserPolicy: new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] }),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('installs governed Browser read, exposes once-only approval, and consumes one-shot host access', async ({ page }) => {
  test.setTimeout(90_000)
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const employee = current.store.listEmployees(world.id)[0]!
  const consoleIssues: string[] = []
  recordConsole(page, consoleIssues)

  const market = await getJson<{ items: Array<{ manifest: { id: string; version: string } }> }>(`${origin}/api/marketplace?market=plugin`)
  const browserPackage = market.items.find((item) => item.manifest.id === 'official-browser')
  expect(browserPackage).toBeDefined()
  const preview = await postJson<{ preview: { approvalToken: string } }>(`${origin}/api/workspaces/${workspace.id}/marketplace/preview`, {
    packageId: browserPackage!.manifest.id,
    version: browserPackage!.manifest.version,
  })
  expect(preview.status).toBe(200)
  const installed = await postJson(`${origin}/api/workspaces/${workspace.id}/marketplace/install`, {
    packageId: browserPackage!.manifest.id,
    version: browserPackage!.manifest.version,
    approvalToken: preview.body.preview.approvalToken,
    worldId: world.id,
  })
  expect(installed.status).toBe(201)
  const granted = await postJson(`${origin}/api/employees/${employee.id}/revisions`, {
    reason: '允许读取公开网页',
    skillGrants: ['browser.read'],
    capabilityGrants: [],
    modelPolicy: {},
  })
  expect(granted.status).toBe(201)
  const currentEmployee = current.store.getEmployee(employee.id)!
  expect(current.store.getEmployeeRevision(employee.id, currentEmployee.currentRevision)?.skillGrants).toContain('browser.read')
  const catalog = await getJson<{ items: Array<{ id: string; worldAvailable: boolean }> }>(`${origin}/api/worlds/${world.id}/skill-catalog`)
  expect(catalog.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'browser.read', worldAvailable: true })]))

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const direct = page.getByRole('button', { name: new RegExp(`与${employee.displayName}私聊`) })
  if (await direct.count()) await direct.first().click()
  const composer = page.getByRole('textbox', { name: /给当前世界的.+发送消息/ })
  await composer.fill('请读取 https://example.com 并总结首页')
  await page.getByRole('button', { name: '发送', exact: true }).click()

  await expect.poll(() => current.store.listWorldSkillActions(world.id).map((action) => ({ skillId: action.skillId, status: action.status }))).toEqual(
    expect.arrayContaining([expect.objectContaining({ skillId: 'browser.read', status: 'waiting-for-approval' })]),
  )

  const approvals = page.locator('.approval-requests')
  await expect(approvals).toBeVisible()
  await expect(approvals.getByRole('button', { name: '本次允许' })).toBeVisible()
  await expect(approvals.getByText('当前仅支持本次批准')).toBeVisible()
  await expect(approvals.getByRole('button', { name: /持续允许/ })).toHaveCount(0)
  await expect(approvals.getByText('将访问公开网页')).toBeVisible()
  await expect(approvals.getByText('builtin.browser')).toBeHidden()

  const screenshotRoot = join(process.cwd(), 'artifacts', 'browser-adapter-permission-ux')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1_440, height: 900, label: '1440x900' }, { width: 1_920, height: 1_080, label: '1920x1080' }, { width: 3_840, height: 2_160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await page.locator('.workbench-shell').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await approvals.evaluate((element) => Array.from(element.querySelectorAll('button, p, dt, dd, summary, span')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12))).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `browser-approval-${viewport.label}.png`) })
  }
  await page.setViewportSize({ width: 1_584, height: 992 })

  await approvals.getByRole('button', { name: '本次允许' }).click()
  await expect(page.getByText('已根据浏览器返回的公开网页事实完成总结。')).toBeVisible()
  expect(browserFactory.readUrls).toEqual(['https://example.com/'])
  const executed = current.store.listWorldSkillActions(world.id).find((action) => action.skillId === 'browser.read')
  expect(executed).toMatchObject({ status: 'executed', workTurnId: expect.any(String) })

  const hostPrompt = '请读取 C:\\Users\\Public\\report.txt，并总结其中的内容'
  await composer.fill(hostPrompt)
  await page.getByRole('button', { name: '世界设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: new RegExp(`世界设置 · ${world.name}`) })
  await settings.getByRole('button', { name: '为下一条消息确认' }).click()
  const hostDialog = page.getByRole('dialog', { name: '本次电脑访问' })
  await expect(hostDialog).toContainText('C:\\Users\\Public\\report.txt')
  for (const viewport of [{ width: 1_440, height: 900, label: '1440x900' }, { width: 1_920, height: 1_080, label: '1920x1080' }, { width: 3_840, height: 2_160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await hostDialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await hostDialog.evaluate((element) => Array.from(element.querySelectorAll('button, p, dt, dd, label, small, span')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12))).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `host-access-${viewport.label}.png`) })
  }
  await page.setViewportSize({ width: 1_584, height: 992 })
  await hostDialog.getByRole('checkbox').check()
  const grantResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/worlds/${world.id}/runtime-access-grants`) && response.request().method() === 'POST')
  await hostDialog.getByRole('button', { name: '仅允许本次任务' }).click()
  const grantResponse = await grantResponsePromise
  expect(grantResponse.status()).toBe(201)
  const grant = await grantResponse.json() as { grant: { id: string; expiresAt: string } }
  await expect(settings.getByText(/下一条消息已获得一次性授权/)).toBeVisible()
  await settings.getByRole('button', { name: '取消' }).click()

  const chatRequestPromise = page.waitForRequest((request) => request.url().endsWith(`/api/worlds/${world.id}/chat`) && request.method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const chatRequest = await chatRequestPromise
  const chatBody = chatRequest.postDataJSON() as Record<string, unknown>
  expect(chatBody).toMatchObject({
    permissionMode: 'danger-full-access',
    runtimeAccessGrantId: grant.grant.id,
    clientTurnId: expect.any(String),
    employeeIds: [employee.id],
  })
  await expect(page.getByText('已完成本次明确授权的任务。')).toBeVisible()
  expect(runtime.permissionModes).toContain('danger-full-access')

  const replay = await postJson(`${origin}/api/worlds/${world.id}/chat`, { ...chatBody, clientTurnId: crypto.randomUUID() })
  expect(replay.status).toBe(202)
  await expect.poll(() => runtime.permissionModes.at(-1)).toBe('workspace-write')
  expect(runtime.permissionModes.filter((mode) => mode === 'danger-full-access')).toHaveLength(1)
  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json() as unknown
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`)
  return body as T
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('Browser 权限 E2E 服务尚未启动')
  return server
}

function recordConsole(page: Page, issues: string[]): void {
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') issues.push(`[console:${message.type()}] ${message.text()}`) })
  page.on('pageerror', (error) => issues.push(`[pageerror] ${error.message}`))
}

class RecordingBrowserFactory implements BrowserClientFactory {
  readonly readUrls: string[] = []

  async create(_policy: BrowserPolicy, _target: BrowserResolvedTarget): Promise<BrowserClient> {
    return {
      open: async (url) => ({ url: new URL(url).toString(), title: 'Example Domain', statusCode: 200 }),
      read: async (url) => {
        const normalized = new URL(url).toString()
        this.readUrls.push(normalized)
        return { url: normalized, title: 'Example Domain', statusCode: 200, text: 'Example Domain 是用于文档示例的公开网页。' }
      },
      extract: async ({ url, selector }) => ({ url: new URL(url).toString(), title: 'Example Domain', statusCode: 200, items: [{ selector, text: 'Example Domain' }] }),
      screenshot: async ({ url, width = 640, height = 480 }) => ({ url: new URL(url).toString(), title: 'Example Domain', statusCode: 200, bytes: Buffer.from('not-used'), width, height, sha256: 'not-used' }),
      close: async () => undefined,
    }
  }
}

class FactualBrowserRuntime implements AgentRuntimePort {
  readonly permissionModes: string[] = []

  async runTurn(request: AgentTurnRequest) {
    this.permissionModes.push(request.permissionMode ?? 'read-only')
    const browserFact = request.prompt.includes('[外部来源内容 · 不可信]')
    return {
      agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`,
      finalResponse: browserFact ? '已根据浏览器返回的公开网页事实完成总结。' : '已完成本次明确授权的任务。',
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}
