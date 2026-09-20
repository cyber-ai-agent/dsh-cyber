import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { auditVisuals } from './visual-audit-helpers.js'

let server: CyberServer
let stateRoot = ''; let origin = ''; let workspaceId = ''; let worldId = ''
let firstId = ''; let secondId = ''; let firstModel = ''; let secondModel = ''
let calls: Array<{ employeeId: string; modelId: string | undefined; override: string | undefined }> = []
let release: (() => void) | undefined
let consoleIssues: string[] = []
const output = process.env.DSH_AUDIT_SCREENSHOT_DIR ?? join(tmpdir(), 'dsh-visual-redesign')
const priorCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
const reply = '## 交付检查清单\n\n可以按这三个步骤核对本次交付。\n\n### 1. 确认目标和交付范围\n\n检查本次交付的目标是否明确，范围是否与需求一致。\n\n### 2. 核对内容、来源与负责人\n\n逐项核对交付内容的来源，并确认对应的负责人。\n\n### 3. 记录验收结论与修改要求\n\n根据检查结果，记录验收结论，并明确需要修改的事项。'

test.beforeEach(async ({ page }) => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-visual-'))
  calls = []; release = undefined; consoleIssues = []
  server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, webRoot: join(process.cwd(), 'packages/web/dist'), bootstrapDefaultWorld: true,
    conversationTaskIntent: { async classify() { return undefined } },
    runtime: {
      async runTurn(request: AgentTurnRequest) {
        // Mirrors the existing host fallback when the UI leaves model routing
        // to the role assignment. No provider/model network is used here.
        const model = server.store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)
        calls.push({ employeeId: request.agent.id, modelId: model?.id, override: request.modelProfileId })
        const prompt = server.store.listMessages(request.conversationId).findLast((message) => message.metadata.workTurnId === request.workTurnId && message.kind === 'user')?.content ?? ''
        request.onEvent?.({ kind: 'turn.started', source: 'visual-fixture', sourceSessionId: request.conversationId, metadata: {} })
        if (prompt.includes('等待检查')) await new Promise<void>((resolve) => { release = resolve })
        request.onEvent?.({ kind: 'assistant.message', source: 'visual-fixture', sourceSessionId: request.conversationId, content: reply, metadata: {} })
        request.onEvent?.({ kind: 'turn.completed', source: 'visual-fixture', sourceSessionId: request.conversationId, metadata: {} })
        return { agentSessionId: request.conversationId, finalResponse: reply, eventCount: 3 }
      },
      async close() { release?.() },
    },
  })
  const workspace = server.store.listWorkspaces()[0]!
  workspaceId = workspace.id
  const world = server.store.listWorlds(workspace.id)[0]!
  worldId = world.id
  firstId = server.store.listEmployees(worldId)[0]!.id
  secondId = server.store.recruitEmployee({ workspaceId, worldId, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '交付审阅员' }).id
  const profile = (name: string) => server.store.saveModelProfile({ workspaceId, displayName: name, providerKind: 'openai-compatible-local', baseUrl: 'http://127.0.0.1:9/v1', modelId: name, api: 'openai-completions', settings: {} }).id
  firstModel = profile('管家模型'); secondModel = profile('审阅模型')
  server.store.saveModelAssignment({ workspaceId, scope: 'employee', scopeId: firstId, modelProfileId: firstModel })
  server.store.saveModelAssignment({ workspaceId, scope: 'employee', scopeId: secondId, modelProfileId: secondModel })
  server.store.createSession({ workspaceId, worldId, kind: 'group', title: '发布协作', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: firstId, kind: 'employee' }, { participantId: secondId, kind: 'employee' }] })
  origin = (await server.start()).origin
  attachAppConsoleRecorder(page, consoleIssues)
  await mkdir(output, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
})

test.afterEach(async ({}, info) => {
  release?.(); await server.close()
  await info.attach('console', { body: Buffer.from(JSON.stringify(consoleIssues, null, 2)), contentType: 'application/json' })
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 3 })
  if (priorCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = priorCatalog
})

async function click(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true })
  await expect(button).toBeVisible(); await expect(button).toBeEnabled(); await button.click()
}
async function mode(page: Page, label: '白天' | '黑夜') {
  await click(page, '设置'); await click(page, label); await click(page, '保存外观设置')
  await expect(page.locator('html')).toHaveAttribute('data-resolved-color-scheme', label === '白天' ? 'light' : 'dark')
}

test('renders a consistent light and dark workbench, opens deliverables, and expands the real world', async ({ page }) => {
  test.setTimeout(100_000)
  await expect(page.locator('html')).toHaveAttribute('data-resolved-color-scheme', 'light')
  await click(page, '与管家私聊')
  await page.locator('.composer textarea').fill('请整理一份交付检查清单，重点检查结果和来源。')
  await click(page, '发送')
  const answer = page.locator('.message:not(.message--owner)').filter({ hasText: '交付检查清单' })
  await expect(answer).toBeVisible(); await expect(answer).not.toHaveClass(/message--streaming/)
  await answer.getByRole('button', { name: '回复操作', exact: true }).click()
  await page.getByRole('menuitem', { name: /将回复保存为文档/ }).click()
  await expect(answer.getByRole('button', { name: '查看文档' })).toBeVisible()
  await expect(page.locator('.composer').getByRole('button', { name: /模型/ })).toHaveCount(0)
  const measurements: unknown[] = []
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') await mode(page, '黑夜')
    for (const [width, height] of [[1440, 900], [1586, 992], [1920, 1080], [3840, 2160], [1100, 760]]) {
      await page.setViewportSize({ width: width!, height: height! })
      await page.locator('.message-scroll').hover(); await page.mouse.wheel(0, -10000)
      await expect.poll(() => page.locator('.message-scroll').evaluate((node) => node.scrollTop)).toBe(0)
      await expect(page.locator('.send-button')).toBeInViewport()
      await expect(page.getByRole('button', { name: '展开世界' })).toBeInViewport()
      const visual = await auditVisuals(page.locator('.chat-workbench'))
      expect(visual.minFontSize).toBeGreaterThanOrEqual(12)
      expect(visual.minContrast).toBeGreaterThanOrEqual(4.5)
      const geometry = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.workbench-shell')!
        const host = document.querySelector<HTMLElement>('.world-canvas-host')!
        const canvas = host.querySelector('canvas')!
        const center = document.querySelector<HTMLElement>('.center-pane')!
        return { width: innerWidth, height: innerHeight, shellOverflow: shell.scrollWidth - shell.clientWidth, chatWidth: center.clientWidth, host: host.getBoundingClientRect().toJSON(), canvas: canvas.getBoundingClientRect().toJSON() }
      })
      expect(geometry.shellOverflow).toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.canvas.width - geometry.host.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(geometry.canvas.height - geometry.host.height)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: join(output, `redesign-${theme}-${width}x${height}.png`) })
      measurements.push({ theme, visual, ...geometry })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await mode(page, '白天')
  await click(page, '展开世界')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe('world-runtime-dock')
  await click(page, '显示全景')
  await page.screenshot({ path: join(output, 'redesign-world-expanded.png') })
  await click(page, '退出全屏世界')
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  await click(page, '查看文档')
  await expect(page.getByRole('region', { name: '交付检查清单产物详情' })).toContainText('确认目标和交付范围')
  await page.screenshot({ path: join(output, 'redesign-delivery.png') })
  await writeFile(join(output, 'redesign-visual-qa.json'), JSON.stringify({ measurements, console: consoleIssues, runtime: 'deterministic' }, null, 2))
  expect(consoleIssues).toEqual([])
})

test('uses each role assignment, configures models through the tools menu, and preserves queue actions', async ({ page }) => {
  test.setTimeout(75_000)
  const requests: Record<string, unknown>[] = []
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith(`/api/worlds/${worldId}/chat`)) requests.push(request.postDataJSON()) })
  await click(page, '与管家私聊')
  await page.locator('.composer textarea').fill('请检查交付资料')
  await click(page, '发送'); await expect.poll(() => calls.length).toBe(1)
  await click(page, '与交付审阅员私聊')
  await page.locator('.composer textarea').fill('请独立审阅结果')
  await click(page, '发送'); await expect.poll(() => calls.length).toBe(2)
  expect(calls.map((call) => call.modelId)).toEqual([firstModel, secondModel])
  expect(calls.every((call) => call.override === undefined)).toBe(true)
  expect(requests.every((request) => !('modelProfileId' in request) && !('modelProfileIds' in request))).toBe(true)
  await click(page, '工具'); await click(page, '模型中心')
  const dialog = page.getByRole('dialog', { name: 'AI 模型管理中心' })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('dialog', { name: '工作台工具' })).toBeHidden()
  await dialog.getByRole('button', { name: '模型设置', exact: true }).click()
  await dialog.getByRole('combobox', { name: '分配范围', exact: true }).selectOption(worldId)
  await dialog.locator('.model-hub__assign-targets').getByRole('button').filter({ has: page.getByText('管家', { exact: true }) }).click()
  const row = dialog.locator('.model-hub__assign-table tbody tr').filter({ hasText: '审阅模型' })
  await row.getByRole('button', { name: '应用', exact: true }).click()
  await expect.poll(() => server.store.getModelAssignment(workspaceId, 'employee', firstId)?.modelProfileId).toBe(secondModel)
  await click(page, '关闭模型中心')
  await click(page, '与管家私聊')
  await page.locator('.composer textarea').fill('等待检查')
  await click(page, '发送'); await expect.poll(() => calls.length).toBe(3)
  expect(calls[2]?.modelId).toBe(secondModel)
  await page.locator('.composer textarea').fill('补充待处理内容')
  await click(page, '排队发送')
  const queue = page.getByRole('region', { name: '待处理消息' })
  await expect(queue).toContainText('补充待处理内容')
  await queue.getByRole('button', { name: /排队消息操作/ }).click()
  await page.getByRole('menuitem', { name: '优先处理', exact: true }).click()
  await queue.getByRole('button', { name: /排队消息操作/ }).click()
  await page.getByRole('menuitem', { name: '取消排队消息', exact: true }).click()
  await expect(queue).toHaveCount(0)
  release?.()
  await expect(page.locator('.message--streaming')).toHaveCount(0)
  await page.reload(); await click(page, '与管家私聊')
  await expect(page.locator('.composer').getByRole('button', { name: /模型/ })).toHaveCount(0)
  expect(server.store.getModelAssignment(workspaceId, 'employee', firstId)?.modelProfileId).toBe(secondModel)
  expect(consoleIssues).toEqual([])
})
