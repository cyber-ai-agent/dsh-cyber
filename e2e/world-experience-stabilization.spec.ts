import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { openDockTab } from './dock-test-helpers.js'

let server: CyberServer
let origin: string
let stateRoot: string

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-experience-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new QuietBrowserRuntime(),
    bootstrapDefaultWorld: true,
  })
  origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const market = await getJson<{ items: Array<{ manifest: { id: string; version: string } }> }>(`${origin}/api/marketplace?market=skin`)
  const skin = market.items.find((item) => item.manifest.id === 'maid-atelier')
  if (skin === undefined) throw new Error('maid-atelier skin is missing from the local marketplace')
  const preview = await postJson<{ preview: { approvalToken: string } }>(`${origin}/api/workspaces/${workspace.id}/marketplace/preview`, {
    packageId: skin.manifest.id,
    version: skin.manifest.version,
  })
  expect(preview.status, JSON.stringify(preview.body)).toBe(200)
  const install = await postJson(`${origin}/api/workspaces/${workspace.id}/marketplace/install`, {
    packageId: skin.manifest.id,
    version: skin.manifest.version,
    approvalToken: preview.body.preview.approvalToken,
    worldId: world.id,
  })
  expect(install.status, JSON.stringify(install.body)).toBe(201)
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

async function ensureWorld(page: import('@playwright/test').Page) {
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(onboarding.or(page.locator('.workbench-shell'))).toBeVisible()
  if (await onboarding.isVisible()) await page.getByRole('button', { name: '创建我的世界' }).click()
  await expect(page.locator('.workbench-shell')).toBeVisible()
}

test('previews, cancels and persists world appearance settings', async ({ page }) => {
  await ensureWorld(page)

  const root = page.locator('html')
  const before = await root.getAttribute('data-skin')
  // World Scene 属于世界本身，会话皮肤不得改写它；记下切换前的场景身份用于比对。
  const worldCanvas = page.locator('.world-canvas-host')
  const sceneThemeBefore = await worldCanvas.getAttribute('data-theme-id')
  expect(sceneThemeBefore).toBeTruthy()

  const openWorldSettings = async () => {
    await page.getByRole('button', { name: '世界管理' }).click()
    const opened = page.getByRole('dialog', { name: /世界管理 · 我的世界/ })
    await expect(opened).toBeVisible()
    // 会话皮肤从基础设定分出了自己的分栏。
    await opened.getByRole('button', { name: '会话皮肤', exact: true }).click()
    return opened
  }

  let dialog = await openWorldSettings()
  const deepOcean = dialog.getByRole('button', { name: /深海女仆工坊/ })
  await deepOcean.click()
  await expect(root).toHaveAttribute('data-skin', 'maid-atelier')
  await expect(dialog.getByLabel('聊天视觉实时预览')).toContainText('右侧世界场景仍保持当前世界自己的空间。')

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => root.getAttribute('data-skin')).toBe(before)

  dialog = await openWorldSettings()
  await dialog.getByRole('button', { name: /深海女仆工坊/ }).click()
  await dialog.getByRole('button', { name: '保存世界管理' }).click()
  await expect(dialog.getByRole('status')).toContainText('世界管理设定已保存')
  await expect(dialog).toBeHidden({ timeout: 3_000 })

  dialog = await openWorldSettings()
  await expect(dialog.getByRole('button', { name: /深海女仆工坊/ })).toHaveClass(/is-active/)
  await dialog.getByRole('button', { name: '取消' }).click()

  await expect(root).toHaveAttribute('data-skin', 'maid-atelier')
  await expect.poll(() => root.evaluate((element) => element.style.getPropertyValue('--theme-backdrop-image'))).toContain('maid-palace-night')
  await expect(worldCanvas).toHaveAttribute('data-theme-id', sceneThemeBefore!)
  await expect(page.locator('.world-view__header')).toHaveCount(0)

  const screenshotRoot = join(process.cwd(), 'artifacts', 'world-theme-unified')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `maid-skin-with-own-scene-${viewport.label}.png`) })
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.topbar-world-theme-pill').click()
  await page.locator('.theme-create-btn').click()
  const customizer = page.locator('.theme-customizer-dialog')
  await expect(customizer).toBeVisible()
  expect(await customizer.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: join(screenshotRoot, 'customizer-upload-1440x900.png') })
  const sceneInput = customizer.locator('input[type="file"]').first()
  await sceneInput.setInputFiles(join(process.cwd(), 'packages', 'web', 'public', 'assets', 'skins', 'maid-palace-night.webp'))
  await expect(customizer.locator('.theme-asset-upload__preview img').first()).toHaveAttribute('src', /\/api\/assets\//)
  await customizer.locator('.theme-customizer-dialog__footer .primary-button').click()
  await expect(root).toHaveAttribute('data-skin', /^custom-/)
  await expect.poll(() => root.evaluate((element) => element.style.getPropertyValue('--theme-backdrop-image'))).toContain('/api/assets/')
  await expect(worldCanvas).toHaveAttribute('data-theme-id', sceneThemeBefore!)
  await page.screenshot({ path: join(screenshotRoot, 'uploaded-custom-skin-with-own-scene-1440x900.png') })
})

test('shows existing role instances and warns before creating a duplicate name', async ({ page }) => {
  await ensureWorld(page)
  await expect(page.getByRole('button', { name: '与管家私聊' })).toBeVisible()

  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await dock.getByRole('button', { name: '新增角色', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新增角色' })
  await expect(dialog).toBeVisible()
  // 目录里还有中枢/日程/知识管家等模板，这里要的是基础「管家」模板本身。
  await dialog.getByRole('button', { name: /^管家 v1/ }).click()
  await expect(dialog.getByText('当前世界已有 1 名', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/当前世界已有 1 名角色来自这份模板：管家/)).toBeVisible()

  const name = dialog.getByLabel('角色名字（可选）')
  await name.fill('管家')
  await expect(dialog.getByText('当前世界已有同名角色，建议换一个名字以便区分。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '再创建一名' })).toBeEnabled()
  await dialog.getByRole('button', { name: '取消' }).click()
})

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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json() as unknown
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`)
  return body as T
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as T }
}
