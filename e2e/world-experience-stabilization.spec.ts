import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

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
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

async function ensureWorld(page: import('@playwright/test').Page) {
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  if (await onboarding.isVisible()) await page.getByRole('button', { name: '创建我的世界' }).click()
  await expect(page.locator('.workbench-shell')).toBeVisible()
}

test('previews, cancels and persists world appearance settings', async ({ page }) => {
  await ensureWorld(page)

  const app = page.locator('.app-frame')
  const before = await app.evaluate((element) => getComputedStyle(element).getPropertyValue('--accent').trim())

  await page.getByRole('button', { name: '世界设置' }).click()
  let dialog = page.getByRole('dialog', { name: /世界设置 · 我的世界/ })
  await expect(dialog).toBeVisible()
  const accent = dialog.getByLabel('强调色')
  await accent.fill('#3366ff')
  await expect.poll(() => app.evaluate((element) => getComputedStyle(element).getPropertyValue('--accent').trim())).not.toBe(before)
  await expect(dialog.getByText('这里的样式会跟着设置实时变化。')).toBeVisible()

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => app.evaluate((element) => getComputedStyle(element).getPropertyValue('--accent').trim())).toBe(before)

  await page.getByRole('button', { name: '世界设置' }).click()
  dialog = page.getByRole('dialog', { name: /世界设置 · 我的世界/ })
  await dialog.getByLabel('强调色').fill('#3366ff')
  await dialog.getByRole('button', { name: '保存世界设置' }).click()
  await expect(dialog.getByRole('status')).toContainText('世界设置已保存')
  await expect(dialog).toBeHidden({ timeout: 3_000 })

  await page.getByRole('button', { name: '世界设置' }).click()
  dialog = page.getByRole('dialog', { name: /世界设置 · 我的世界/ })
  await expect(dialog.getByLabel('强调色')).toHaveValue('#3366ff')
  await dialog.getByRole('button', { name: '取消' }).click()
})

test('shows existing role instances and warns before creating a duplicate name', async ({ page }) => {
  await ensureWorld(page)
  await expect(page.getByRole('button', { name: '与管家私聊' })).toBeVisible()

  const dock = page.getByRole('region', { name: '世界与角色档案侧边栏' })
  await dock.getByRole('button', { name: '档案', exact: true }).click()
  await dock.getByRole('button', { name: '新增角色', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新增角色' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /管家 v1/ }).click()
  await expect(dialog.getByText('当前世界已有 1 名', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/当前世界已经有 1 名角色来自这份模板：管家/)).toBeVisible()

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
