import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { WorkSystemRepository } from '../packages/persistence/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let stateRoot = ''
let origin = ''
let port = 0
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
const options = () => ({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'), port, bootstrapDefaultWorld: true })

test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'cyber-reconnect-browser-'))
  server = await createCyberServer(options())
  const address = await server.start()
  origin = address.origin; port = address.port
})
test.afterAll(async () => {
  await server?.close()
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true })
  if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog
})

async function openTasks(page: Page) {
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.getByRole('button', { name: '更多', exact: true })).toBeVisible()
  const tab = page.getByRole('tab', { name: '任务', exact: true })
  if (await tab.count() === 0) {
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: '任务', exact: true }).click()
  } else await tab.click()
}

test('reconciles persisted tasks after a real service restart without reloading the page', async ({ page }, info) => {
  test.setTimeout(60_000)
  const current = server!
  const workspaceId = current.store.listWorkspaces()[0]!.id
  const worldId = current.store.listWorlds(workspaceId)[0]!.id
  const input = { workspaceId, worldId, priority: 'normal' as const, description: '用于验证连接恢复的持久化任务，不调用外部模型。' }
  current.work.create({ ...input, title: '已有任务' })
  const issues: string[] = []; attachAppConsoleRecorder(page, issues)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin); await openTasks(page)
  const panel = page.getByRole('region', { name: '任务工作台' })
  await expect(panel.locator('.task-board')).toContainText('已有任务')
  // Sever the real SSE transport; seed durable changes before accepting new
  // connections. No fake DOM events, hidden controls, or page reload is used.
  const faultStart = issues.length
  await page.context().setOffline(true)
  await current.close(); server = undefined
  server = await createCyberServer(options())
  const repository = new WorkSystemRepository(server.store.database)
  for (const [status, title] of [['planning', '规划中的任务'], ['ready', '准备执行的任务'], ['recovery-required', '需要人工恢复的任务']] as const) {
    const task = server.work.create({ ...input, title })
    repository.transitionTask(task.id, ['draft'], status)
  }
  await server.start()
  await page.context().setOffline(false)
  await expect(panel.locator('.task-board')).toContainText('准备执行的任务', { timeout: 15_000 })
  for (const title of ['规划中的任务', '准备执行的任务', '需要人工恢复的任务']) {
    await expect(panel.locator('.task-board')).toContainText(title)
  }
  const faultIssues = issues.splice(faultStart)
  // Network errors are expected only during our deliberate outage; page errors
  // or application errors never become acceptable merely because it was offline.
  expect(faultIssues.filter((item) => !/^\[console:error\] Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_CLOSED|EMPTY_RESPONSE)/.test(item))).toEqual([])
  await panel.locator('.task-board').getByRole('button', { name: /准备执行的任务/ }).click()
  await expect(panel.locator('.task-detail h2')).toHaveText('准备执行的任务')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: info.outputPath(`reconnect-${size.width}x${size.height}.png`) })
  }
  await writeFile(info.outputPath('console.json'), JSON.stringify({ normal: issues, deliberateOutage: faultIssues }, null, 2))
  expect(issues).toEqual([])
})
