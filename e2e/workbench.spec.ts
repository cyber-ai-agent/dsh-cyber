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
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new BrowserRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('onboards, recruits, talks, browses dossiers and previews a real workspace file', async ({ page }) => {
  await page.goto(origin)

  await expect(page.getByRole('heading', { name: '创建第一个本地世界' })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: '创建本地工作区' }).click()

  await expect(page.getByRole('heading', { name: '当前世界还没有员工' })).toBeVisible()
  const composer = page.getByRole('textbox', { name: '给当前世界的员工发送消息' })
  await expect(composer).toBeDisabled()
  await expect(composer).toHaveCount(1)

  await page.getByRole('button', { name: '招聘第一位员工' }).click()
  const market = page.getByRole('dialog', { name: '员工市场' })
  await expect(market).toBeVisible()
  await market.getByRole('button', { name: /开发工程师 v1/ }).click()
  await market.getByRole('textbox', { name: '员工称呼（可选）' }).fill('阿帆')
  await market.getByRole('button', { name: '确认招聘' }).click()

  await expect(market).toBeHidden()
  await expect(composer).toBeEnabled()
  await expect(page.getByRole('button', { name: /阿帆.*软件工程师/ })).toBeVisible()

  const dock = page.getByRole('region', { name: '产物与世界侧边栏' })
  await expect(dock.getByText('阿帆 / 数字员工档案')).toBeVisible()
  await dock.getByRole('button', { name: '全员档案' }).click()
  await expect(dock.getByText('全员数字档案')).toBeVisible()
  await expect(dock.getByRole('article').filter({ hasText: '阿帆' })).toBeVisible()

  await composer.fill('@阿帆 请确认真实回合')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('我先建立性能基线。')).toBeVisible()
  await page.getByText('阿帆的思考过程').click()
  await expect(page.getByText('核对事实与权限。')).toBeVisible()
  await expect(page.getByText('search_workspace').first()).toBeVisible()

  await dock.getByRole('button', { name: '文件', exact: true }).click()
  await dock.getByRole('button', { name: /packages.*目录/ }).click()
  await dock.getByRole('button', { name: /web.*目录/ }).click()
  await dock.getByRole('button', { name: /package\.json.*可预览/ }).click()
  await expect(dock.getByText('本地工作区只读预览')).toBeVisible()
  await expect(dock.getByRole('button', { name: '新标签打开' })).toBeVisible()

  await expect(page.locator('.composer')).toHaveCount(1)
  await expect(page.locator('.workbench-shell')).toBeVisible()
})

test('keeps the workbench readable and the world viewport filled on a 4K display', async ({ page }) => {
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建本地工作区' }).click()
  }
  const dock = page.getByRole('region', { name: '产物与世界侧边栏' })
  await dock.getByRole('button', { name: '世界', exact: true }).click()

  const left = await page.locator('.left-pane').boundingBox()
  const center = await page.locator('.center-pane').boundingBox()
  const right = await page.locator('.right-pane').boundingBox()
  const stage = await page.locator('.world-stage').boundingBox()
  const canvas = await page.locator('.world-canvas').boundingBox()

  expect(left?.width ?? 0).toBeGreaterThan(330)
  expect(center?.width ?? 0).toBeGreaterThan(1_200)
  expect(right?.width ?? 0).toBeGreaterThan(700)
  expect(Math.abs((stage?.height ?? 0) - (canvas?.height ?? 0))).toBeLessThan(3)
  expect(Math.abs(((stage?.width ?? 1) / (stage?.height ?? 1)) - (46 / 34))).toBeLessThan(.03)
  await expect(dock.getByLabel('世界实时活动')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '给当前世界的员工发送消息' })).toHaveCount(1)
})

test('opens the dossier as an all-employee information directory', async ({ page }) => {
  await page.goto(`${origin}?demo=1`)
  const dock = page.getByRole('region', { name: '产物与世界侧边栏' })
  await dock.getByRole('button', { name: '档案', exact: true }).click()

  await expect(dock.getByText('全员数字档案')).toBeVisible()
  await expect(dock.getByText('8 名角色')).toBeVisible()
  await expect(dock.getByRole('article')).toHaveCount(8)
  for (const employee of ['小羽', '老周', '阿帆', '小Q', '安澜', '墨游', '小E', '秘书']) {
    await expect(dock.getByRole('article').filter({ hasText: employee })).toBeVisible()
  }
  await expect(dock.getByText('8', { exact: true }).first()).toBeVisible()
  await expect(dock.getByText('32', { exact: true })).toBeVisible()
})

class BrowserRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    const events = [
      { kind: 'turn.started', sourceSequence: 1 },
      { kind: 'assistant.reasoning', sourceSequence: 2, content: '核对事实与权限。' },
      { kind: 'tool.started', sourceSequence: 3, toolName: 'search_workspace', callId: `call-${request.agent.id}` },
      { kind: 'tool.completed', sourceSequence: 4, callId: `call-${request.agent.id}`, failed: false },
      { kind: 'assistant.message', sourceSequence: 5, content: '我先建立性能基线。' },
      { kind: 'turn.completed', sourceSequence: 6 },
    ] as const
    for (const event of events) request.onEvent?.({ ...event, source: 'browser-e2e', sourceSessionId: agentSessionId, metadata: {} })
    return { agentSessionId, finalResponse: '我先建立性能基线。', eventCount: events.length }
  }

  async close(): Promise<void> {}
}
