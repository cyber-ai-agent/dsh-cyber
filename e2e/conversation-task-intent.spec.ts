import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import type { ConversationTaskIntentPort } from '../packages/server/lib/services/conversation-task-intent-classifier.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

/**
 * The owner's own path: one clear instruction typed into the chat becomes one
 * task in the task list, visible while the panel is open and without a reload,
 * and an ordinary question adds nothing beside it.
 *
 * The classifier is a deterministic stub, so this run never calls a model.
 */

const INSTRUCTION = '把这周的用户反馈整理成一份改进清单，标出优先级。'
const QUESTION = '用户反馈一般多久处理一轮比较合适？'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

const intent: ConversationTaskIntentPort = {
  async classify(input) {
    return input.prompt.includes(INSTRUCTION)
      ? { title: '整理用户反馈改进清单', description: '汇总本周用户反馈，按影响面排序，输出一份带优先级的改进清单。', priority: 'high' }
      : undefined
  },
}

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-task-intent-e2e-'))
  server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0, bootstrapDefaultWorld: true, runtime: new ChatRuntime(), conversationTaskIntent: intent,
  })
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }) })

test('records one source task, follows its completion and confirms without repeating work', async ({ page }) => {
  const current = server!
  const world = current.store.listWorlds(current.store.listWorkspaces()[0]!.id)[0]!
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)

  await page.goto(origin)
  await openTasks(page)
  await expect(page.getByText('还没有任务')).toBeVisible()

  // An ordinary question is answered and leaves the list exactly as it was.
  await page.getByRole('button', { name: '与管家私聊' }).click()
  await page.getByRole('textbox', { name: '给当前世界的角色发送消息' }).fill(QUESTION)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('管家 已回复。')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('还没有任务')).toBeVisible()
  expect(current.work.list(world.id)).toEqual([])

  await page.reload()
  await openTasks(page)
  await expect(page.getByText('还没有任务')).toBeVisible()

  // The task list stays open from here on: it has to learn about the task the
  // host recorded, not be told by a reload.
  await page.getByRole('button', { name: '与管家私聊' }).click()
  await page.getByRole('textbox', { name: '给当前世界的角色发送消息' }).fill(INSTRUCTION)
  await page.getByRole('button', { name: '发送', exact: true }).click()

  const row = page.getByRole('button', { name: /整理用户反馈改进清单/ })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText('来自对话')
  // A source task follows the actual chat, rather than keeping a separate
  // unstarted draft forever. Acceptance does not run the instruction again.
  await expect(page.locator('.task-status')).toHaveText('等待验收')
  expect(current.work.list(world.id)).toHaveLength(1)
  const taskId = current.work.list(world.id)[0]!.id
  await expect(page.getByRole('heading', { name: '来源对话' })).toBeVisible()
  const source = page.locator('.task-source')
  await expect(source).toContainText('对话执行已结束')
  await expect(source).toContainText('1 个角色运行')
  await source.locator('.task-source-result summary').click()
  await expect(source.locator('.task-source-result pre')).toContainText('管家 已回复。')
  const repeat = page.getByRole('button', { name: '生成计划并执行' })
  await expect(repeat).not.toBeVisible()
  await page.locator('.task-source-retry > summary').click()
  await expect(repeat).toBeVisible()
  await page.locator('.task-source-retry > summary').click()
  const sourceRunIds = current.work.detail(taskId).sourceTurn!.runs.map((run) => run.id)
  await page.getByRole('button', { name: '确认完成', exact: true }).click()
  await expect(page.locator('.task-status')).toHaveText('已完成')
  await expect(source.getByRole('heading')).toHaveText('已确认完成')
  expect(current.work.detail(taskId).runs).toEqual([])
  expect(current.work.detail(taskId).sourceTurn!.runs.map((run) => run.id)).toEqual(sourceRunIds)
  await expect(page.locator('.task-source-retry')).toHaveCount(0)

  const screenshotRoot = join(process.cwd(), 'artifacts', 'conversation-task-intent')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    const panel = page.getByRole('region', { name: '任务工作台' })
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `conversation-task-intent-${viewport.label}.png`) })
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
