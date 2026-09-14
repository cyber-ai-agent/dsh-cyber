import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { IntegrationConnection } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'

let server: CyberServer
let stateRoot = ''
let origin = ''
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL

test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'cyber-connection-hub-'))
  server = await createCyberServer({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, bootstrapDefaultWorld: true })
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }); if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL; else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog })

test('opens the connection hub from the top bar, adds an SSH device, and edits without leaking the key', async ({ page }, info) => {
  const consoleIssues: string[] = []; attachAppConsoleRecorder(page, consoleIssues)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  const hubButton = page.getByRole('button', { name: '连接中心', exact: true })
  await expect(hubButton).toBeVisible()
  await hubButton.click()
  const hub = page.getByRole('dialog', { name: '连接中心' })
  await expect(hub).toBeVisible()
  // SSH type is listed; selecting it shows a clean card list with no editor yet.
  await hub.getByRole('button', { name: /SSH 设备/ }).click()
  const list = hub.locator('.integration-connection-list')
  await expect(hub.locator('.integration-editor')).toBeHidden()
  // Visual gate: the clean card-list state (no editor) at all three viewports.
  const sshCleanRoot = join(process.cwd(), 'artifacts', 'connection-hub-clean-ssh')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(sshCleanRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize(viewport)
    await expect(hub).toBeVisible()
    await expect(hub.locator('.integration-editor')).toBeHidden()
    await page.screenshot({ path: join(sshCleanRoot, `ssh-clean-${viewport.label}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  // Opening the add action reveals the editor below the list.
  await list.getByRole('button', { name: /添加SSH 设备/ }).click()
  await expect(hub.getByRole('heading', { name: /SSH 设备/ })).toBeVisible()
  // Fill the add-connection form fields (device name, host, user) via labels.
  await hub.getByLabel('设备名称').fill('测试主机')
  await hub.getByLabel('主机地址').fill('10.0.0.55')
  await hub.getByLabel('登录用户').fill('root')
  // Password-based login is supported alongside private keys; both stay encrypted.
  await expect(hub.getByLabel('登录密码')).toBeVisible()
  await expect(hub.getByLabel('登录私钥')).toBeVisible()
  await hub.getByLabel('登录密码').fill('passw0rd-demo')
  await hub.getByRole('button', { name: '添加连接' }).click()
  await expect(hub.getByRole('button', { name: /测试主机/ })).toBeVisible()
  // A card click toggles the editor: first click opens it, second click collapses it.
  await hub.getByRole('button', { name: /测试主机/ }).click()
  await expect(hub.locator('.integration-editor')).toBeVisible()
  // Reference shot: the open state (active card + editor below) for visual review.
  const cardStateRoot = join(process.cwd(), 'artifacts', 'connection-hub-card-state')
  const { mkdir: mkdirCardState } = await import('node:fs/promises')
  await mkdirCardState(cardStateRoot, { recursive: true })
  await page.screenshot({ path: join(cardStateRoot, 'card-expanded-1440x900.png') })
  await hub.getByRole('button', { name: /测试主机/ }).click()
  await expect(hub.locator('.integration-editor')).toBeHidden()
  // The card's right-edge switch flips 启用/停用 and persists it to the server.
  const card = hub.locator('.integration-connection-card').filter({ hasText: '测试主机' })
  const cardToggle = card.locator('.integration-connection-card__enable input')
  await cardToggle.uncheck()
  await expect(cardToggle).toBeChecked({ checked: false })
  await expect(card).toContainText('已停用')
  await cardToggle.check()
  await expect(cardToggle).toBeChecked()
  await expect(card).not.toContainText('已停用')
  // Layout guard: the 启用 switch sits on the card's right edge, right of the name.
  const nameBox = await hub.getByRole('button', { name: /测试主机/ }).boundingBox()
  const toggleBox = await cardToggle.boundingBox()
  expect(nameBox).not.toBeNull(); expect(toggleBox).not.toBeNull()
  expect(toggleBox!.x).toBeGreaterThan(nameBox!.x + nameBox!.width / 2)
  // Confirm the secrets stayed out of the page and API listing.
  expect(await page.locator('body').innerText()).not.toContain('BEGIN OPENSSH')
  expect(await page.locator('body').innerText()).not.toContain('passw0rd-demo')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    await expect(hub).toBeVisible()
    const bounds = await hub.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height)
    await page.screenshot({ path: info.outputPath(`connection-hub-${size.width}x${size.height}.png`) })
  }
  await page.getByRole('button', { name: '关闭连接中心' }).click()
  await expect(hubButton).toBeVisible()
  await writeConsole(info, consoleIssues)
  expect(consoleIssues).toEqual([])
})

test('lets a role authorize a hub SSH device from 角色设置 连接授权 and persists the grant', async ({ page }, info) => {
  const consoleIssues: string[] = []; attachAppConsoleRecorder(page, consoleIssues)
  await page.setViewportSize({ width: 1440, height: 900 })
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const displayName = `授权测试员-${Date.now().toString(36)}`

  // Recruit a role into the default world so it shows in 档案.
  const recruited = await postJson<{ employee: { id: string } }>(`/api/worlds/${world.id}/recruit`, {
    blueprintId: 'cyber-company.software-engineer',
    blueprintVersion: 1,
    displayName,
  })
  expect(recruited.status, JSON.stringify(recruited.body)).toBe(201)
  const employeeId = recruited.body.employee.id

  // Add an SSH device through the top-bar hub.
  await page.goto(origin)
  const hubButton = page.getByRole('button', { name: '连接中心', exact: true })
  await expect(hubButton).toBeVisible()
  await hubButton.click()
  const hub = page.getByRole('dialog', { name: '连接中心' })
  await hub.getByRole('button', { name: /SSH 设备/ }).click()
  // The multi-connection list is clean by default; open the add editor first.
  await hub.locator('.integration-connection-list').getByRole('button', { name: /添加SSH 设备/ }).click()
  await hub.getByLabel('设备名称').fill('授权设备')
  await hub.getByLabel('主机地址').fill('192.168.7.20')
  await hub.getByLabel('登录用户').fill('ops')
  await hub.getByRole('button', { name: '添加连接' }).click()
  await expect(hub.getByRole('button', { name: /授权设备/ })).toBeVisible()
  await hub.getByRole('button', { name: '关闭连接中心' }).click()

  // Open the role settings and check the device under 技能与工具 → 连接授权.
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await dock.getByRole('article').filter({ hasText: displayName }).getByRole('button', { name: `管理${displayName}` }).click()
  const management = page.getByRole('dialog', { name: new RegExp(`角色设置 · ${displayName}`) })
  await management.getByRole('tab', { name: '技能与工具' }).click()
  const deviceRow = management.locator('.connection-grant-row').filter({ hasText: '授权设备' })
  await expect(deviceRow).toBeVisible()
  const deviceCheckbox = deviceRow.getByRole('checkbox')
  await expect(deviceCheckbox).toBeEnabled()
  await deviceCheckbox.check()

  const screenshotRoot = join(process.cwd(), 'artifacts', 'connection-hub-role-grant')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize(viewport)
    await expect(management).toBeVisible()
    const bounds = await management.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    expect(await management.evaluate((element) => {
      const rows = Array.from(element.querySelectorAll('.connection-grant-row'))
      return { hasRows: rows.length > 0, checked: rows.some((row) => (row.querySelector('input') as HTMLInputElement | null)?.checked === true) }
    })).toMatchObject({ hasRows: true, checked: true })
    await page.screenshot({ path: join(screenshotRoot, `role-grant-${viewport.label}.png`) })
  }

  await management.getByRole('button', { name: '保存能力与连接设置' }).click()
  await expect(management).toBeHidden()

  // The revision persisted the connection id; the device id comes from the hub API.
  const listed = await getJson<{ items: IntegrationConnection[] }>(`/api/workspaces/${workspace.id}/integrations`)
  const deviceId = listed.items.find((item) => item.displayName === '授权设备')?.id
  expect(deviceId).toBeDefined()
  const revision = current.store.getEmployeeRevision(employeeId, current.store.getEmployee(employeeId)!.currentRevision)
  expect(revision?.connectionGrants).toEqual([deviceId])

  // Reload: the checkbox stays checked for the same role.
  await page.reload()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '角色')
  await page.getByRole('region', { name: '世界与角色侧边栏' }).getByRole('article').filter({ hasText: displayName }).getByRole('button', { name: `管理${displayName}` }).click()
  const refreshed = page.getByRole('dialog', { name: new RegExp(`角色设置 · ${displayName}`) })
  await refreshed.getByRole('tab', { name: '技能与工具' }).click()
  await expect(refreshed.locator('.connection-grant-row').filter({ hasText: '授权设备' }).getByRole('checkbox')).toBeChecked()
  await refreshed.getByRole('button', { name: '关闭角色设置' }).click()
  await writeConsole(info, consoleIssues)
  expect(consoleIssues).toEqual([])
})

test('adds several MCP services under MCP 连接 and keeps the service slug unique per workspace', async ({ page }, info) => {
  const consoleIssues: string[] = []; attachAppConsoleRecorder(page, consoleIssues)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  const hubButton = page.getByRole('button', { name: '连接中心', exact: true })
  await expect(hubButton).toBeVisible()
  await hubButton.click()
  const hub = page.getByRole('dialog', { name: '连接中心' })
  await expect(hub).toBeVisible()
  // The MCP rail item is now a multi-connection type, labelled 「MCP 连接」.
  await hub.locator('.integration-provider-list').getByRole('button', { name: /MCP 连接/ }).click()
  const list = hub.locator('.integration-connection-list')
  // The multi-connection list starts clean: no editor until a card or add is opened.
  await expect(hub.locator('.integration-editor')).toBeHidden()
  // Visual gate: the clean card-list state (no editor) at all three viewports.
  const mcpCleanRoot = join(process.cwd(), 'artifacts', 'connection-hub-clean-mcp')
  const { mkdir: mkdirMcp } = await import('node:fs/promises')
  await mkdirMcp(mcpCleanRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize(viewport)
    await expect(hub).toBeVisible()
    await expect(hub.locator('.integration-editor')).toBeHidden()
    await page.screenshot({ path: join(mcpCleanRoot, `mcp-clean-${viewport.label}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })

  const addService = async (service: string, endpoint: string, name: string): Promise<void> => {
    await list.getByRole('button', { name: /添加MCP 连接/ }).click()
    await hub.getByLabel('服务标识').fill(service)
    await hub.getByLabel('MCP 地址').fill(endpoint)
    await hub.getByLabel('连接名称').fill(name)
    await hub.getByRole('button', { name: '添加连接', exact: true }).click()
  }

  await addService('github', 'http://127.0.0.1:3900/mcp', 'GitHub MCP')
  await expect(list.getByRole('button', { name: /GitHub MCP/ })).toBeVisible()
  await addService('linear', 'http://127.0.0.1:3901/mcp', 'Linear MCP')
  await expect(list.getByRole('button', { name: /Linear MCP/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /github/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /linear/ })).toBeVisible()

  // A duplicate service slug is rejected at the boundary with a clear message.
  await addService('github', 'http://127.0.0.1:3902/mcp', 'Dup MCP')
  await expect(hub.getByText(/MCP 服务标识「github」/)).toBeVisible()
  // Both saved services expose the 启用 switch on the card's right edge.
  await expect(list.locator('.integration-connection-card__enable input')).toHaveCount(2)

  // The two services stay out of the page's secrets: no token leaks.
  expect(await page.locator('body').innerText()).not.toContain('mcp-secret-bearer')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    await expect(hub).toBeVisible()
    const bounds = await hub.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height)
    await page.screenshot({ path: info.outputPath(`connection-hub-mcp-${size.width}x${size.height}.png`) })
  }
  // The duplicate slug was rejected at the boundary: the only console noise is
  // that expected 409. Anything else must stay clean.
  await page.getByRole('button', { name: '关闭连接中心' }).click()
  await writeConsole(info, consoleIssues)
  expect(consoleIssues.filter((issue) => issue.includes('409 (Conflict)')).length).toBeGreaterThan(0)
  expect(consoleIssues.filter((issue) => !issue.includes('409 (Conflict)'))).toEqual([])
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

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('连接中心 E2E 服务尚未启动')
  return server
}

async function writeConsole(info: test.Info, issues: string[]) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(info.outputPath('console.json'), JSON.stringify(issues, null, 2))
}
