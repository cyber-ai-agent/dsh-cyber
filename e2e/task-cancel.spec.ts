import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

/**
 * The owner clears a task they did not want, with real visible controls: the
 * action asks first, the task leaves the list, and it is still there to look at
 * when they ask for the cancelled ones.
 */

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-task-cancel-e2e-'))
  server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0, bootstrapDefaultWorld: true, runtime: new ChatRuntime(),
  })
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }) })

test('cancels a task after confirming, and can still find it afterwards', async ({ page }) => {
  const current = server!
  const world = current.store.listWorlds(current.store.listWorkspaces()[0]!.id)[0]!
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)

  await page.goto(origin)
  await openTasks(page)
  await expect(page.getByText('还没有任务')).toBeVisible()

  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByLabel('任务标题').fill('误判产生的草稿')
  await page.getByLabel('任务目标').fill('这条任务是分类器搞错了，应该可以清掉。')
  await page.getByRole('button', { name: '创建任务' }).click()

  const row = page.getByRole('button', { name: /误判产生的草稿/ })
  await expect(row).toBeVisible()
  await expect(page.locator('.task-status')).toHaveText('待规划')

  // Asking first: the confirmation is a step, not a second identical button.
  await page.getByRole('button', { name: '取消任务', exact: true }).click()
  await expect(page.getByText('取消后任务不再出现在默认列表，历史记录会保留。')).toBeVisible()
  expect(current.work.list(world.id)).toHaveLength(1)

  await page.getByRole('button', { name: '确认取消' }).click()
  await expect(page.getByText('还没有任务')).toBeVisible()
  expect(current.work.list(world.id)).toEqual([])

  // Cancelled, not deleted.
  await page.getByRole('button', { name: '显示已取消' }).click()
  await expect(page.getByRole('button', { name: /误判产生的草稿/ })).toBeVisible()
  await expect(page.locator('.task-status')).toHaveText('已取消')
  expect(current.work.list(world.id, 'all')).toHaveLength(1)

  const screenshotRoot = join(process.cwd(), 'artifacts', 'task-cancel')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    const panel = page.getByRole('region', { name: '任务工作台' })
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `task-cancel-${viewport.label}.png`) })
  }
  expect(issues, issues.join('\n')).toEqual([])
})

async function openTasks(page: import('@playwright/test').Page) {
  const taskTab = page.getByRole('tab', { name: '任务' })
  if (await taskTab.count() === 0) { await page.getByRole('button', { name: '更多' }).click(); await page.getByRole('menuitemcheckbox', { name: '任务' }).click() }
  else await taskTab.click()
  await expect(page.getByRole('region', { name: '任务工作台' })).toBeVisible()
}

class ChatRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: `e2e-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已回复。`, eventCount: 0 }
  }
  async close() {}
}
