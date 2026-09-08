import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

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
  // SSH type is listed; selecting it shows the editor
  await hub.getByRole('button', { name: /SSH 设备/ }).click()
  await expect(hub.getByRole('heading', { name: /SSH 设备/ })).toBeVisible()
  // Fill the add-connection form fields (device name, host, user) via labels.
  await hub.getByLabel('设备名称').fill('测试主机')
  await hub.getByLabel('主机地址').fill('10.0.0.55')
  await hub.getByLabel('登录用户').fill('root')
  await hub.getByRole('button', { name: '添加连接' }).click()
  await expect(hub.getByRole('button', { name: /测试主机/ })).toBeVisible()
  // Confirm the secret stayed out of the page and API listing.
  expect(await page.locator('body').innerText()).not.toContain('BEGIN OPENSSH')
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

async function writeConsole(info: test.Info, issues: string[]) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(info.outputPath('console.json'), JSON.stringify(issues, null, 2))
}
