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
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-ambient-life-e2e-'))
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
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
}

test('enables and persists bounded role-aware ambient life for one world', async ({ page }) => {
  await ensureWorld(page)

  await page.getByRole('button', { name: '世界活力设置' }).click()
  let dialog = page.getByRole('dialog', { name: '世界活力 · 我的世界' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('不会随机全图游走；不会进入职责无关部门；不会占用其他角色的位置；不会把视觉日常活动伪装成真实 Agent 任务。')).toBeVisible()

  const enabled = dialog.getByRole('checkbox', { name: /启用有岗位逻辑的日常行为/ })
  await expect(enabled).not.toBeChecked()
  await enabled.check()
  await dialog.getByLabel('空闲多久后开始日常行为').selectOption('30000')
  await dialog.getByLabel('两次日常行为的最短间隔').selectOption('300000')
  await dialog.getByLabel('单次最多安排几个角色').selectOption('2')
  await dialog.getByRole('button', { name: '保存设置' }).click()
  await expect(dialog.getByText('✓ 已保存，世界策略将在下一次调度生效')).toBeVisible()
  await expect(dialog).toBeHidden({ timeout: 3_000 })

  await page.getByRole('button', { name: '世界活力设置' }).click()
  dialog = page.getByRole('dialog', { name: '世界活力 · 我的世界' })
  await expect(dialog.getByRole('checkbox', { name: /启用有岗位逻辑的日常行为/ })).toBeChecked()
  await expect(dialog.getByLabel('空闲多久后开始日常行为')).toHaveValue('30000')
  await expect(dialog.getByLabel('两次日常行为的最短间隔')).toHaveValue('300000')
  await expect(dialog.getByLabel('单次最多安排几个角色')).toHaveValue('2')

  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const response = await page.request.get(`${origin}/api/worlds/${encodeURIComponent(world.id)}/ambient-life`)
  expect(response.ok()).toBe(true)
  await expect(response.json()).resolves.toMatchObject({
    settings: {
      worldId: world.id,
      enabled: true,
      minimumIdleMs: 30_000,
      minimumAmbientIntervalMs: 300_000,
      maximumPlansPerTick: 2,
    },
  })

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
