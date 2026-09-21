import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'
import { auditVisuals } from './visual-audit-helpers.js'

let server: CyberServer
let stateRoot = ''; let origin = ''; let port = 0
let calls: Array<{ prompt: string; request: AgentTurnRequest }> = []
let release: (() => void) | undefined
let issues: string[] = []
const output = process.env.DSH_AUDIT_SCREENSHOT_DIR ?? join(tmpdir(), 'dsh-chat-quality-evidence')
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
const multiline = '审阅交付结果时，请逐项检查：\n1. 目标和范围\n2. 来源与证据\n3. 负责人\n4. 截止时间\n5. 验收标准\n6. 待修改事项'
const reply = '# 交付检查清单\n\n1. 确认目标和已有资料。\n2. 核对交付内容与来源。\n3. 阅读结果后记录修改要求。\n\n这是隔离环境中的确定性测试文本。'
const runtime = {
  async runTurn(request: AgentTurnRequest) {
    const prompt = server.store.listMessages(request.conversationId).findLast((message) => message.kind === 'user' && message.metadata.workTurnId === request.workTurnId)!.content
    calls.push({ prompt, request })
    request.onEvent?.({ kind: 'turn.started', source: 'quality-fixture', sourceSessionId: request.conversationId, metadata: {} })
    if (prompt.includes('等待释放')) await new Promise<void>((resolve) => { release = resolve })
    const text = prompt.includes('长回复')
      ? Array.from({ length: 32 }, (_, index) => `### 第 ${index + 1} 项检查\n\n确认目标、核对来源、记录负责人。阅读结果后再补充要求。`).join('\n\n')
        + '\n\n```text\n' + 'wide_code_'.repeat(100) + '\n```\n\n| 项目 | 说明 |\n|---|---|\n| 检查 | ' + '宽表格内容'.repeat(80) + ' |'
      : prompt.includes('补充') ? '已将第二点补充为：核对来源，并标明负责人。' : reply
    request.onEvent?.({ kind: 'assistant.delta', source: 'quality-fixture', sourceSessionId: request.conversationId, content: text.slice(0, 20), metadata: {} })
    request.onEvent?.({ kind: 'assistant.delta', source: 'quality-fixture', sourceSessionId: request.conversationId, content: text.slice(20), metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'quality-fixture', sourceSessionId: request.conversationId, content: text, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'quality-fixture', sourceSessionId: request.conversationId, metadata: {} })
    return { agentSessionId: request.conversationId, finalResponse: text, eventCount: 5 }
  },
  async close() { release?.() },
}
const options = () => ({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'), port, bootstrapDefaultWorld: true, runtime,
  conversationTaskIntent: { async classify(input: { prompt: string }) { return input.prompt.startsWith('任务：') ? { title: '核对交付检查清单', description: '读取来源对话的真实文本，完成检查与验收。', priority: 'normal' as const } : undefined } },
})

test.beforeEach(async ({ page }) => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  calls = []; release = undefined; issues = []; port = 0
  stateRoot = await mkdtemp(join(tmpdir(), 'cyber-chat-quality-'))
  server = await createCyberServer(options())
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  server.store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: '交付审阅员' })
  const address = await server.start(); origin = address.origin; port = address.port
  attachAppConsoleRecorder(page, issues)
  await mkdir(output, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await select(page, '管家')
})
test.afterEach(async ({}, info) => {
  release?.(); await server?.close()
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 3 })
  await info.attach('console', { body: Buffer.from(JSON.stringify(issues, null, 2)), contentType: 'application/json' })
  if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog
})
async function click(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true })
  await expect(button).toBeVisible(); await expect(button).toBeEnabled(); await button.click()
}
async function select(page: Page, name: string) {
  await click(page, `与${name}私聊`)
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', new RegExp(name))
}
async function upload(page: Page) {
  const chooser = page.waitForEvent('filechooser')
  await click(page, '添加附件')
  await (await chooser).setFiles({ name: '验收要求.txt', mimeType: 'text/plain', buffer: Buffer.from('请核对三项清单') })
  await expect(page.locator('.composer-attachment--ready')).toBeVisible()
}
async function daylight(page: Page) {
  if (await page.locator('html').getAttribute('data-resolved-color-scheme') === 'light') return
  await click(page, '设置'); await click(page, '白天'); await click(page, '保存外观设置')
  await expect(page.locator('html')).toHaveAttribute('data-resolved-color-scheme', 'light')
}

test('confirms IME input, queues a follow-up, switches conversations, reads and accepts the saved result', async ({ page }) => {
  test.setTimeout(100_000)
  await daylight(page)
  const input = page.locator('.composer textarea')
  await input.fill('任务：整理交付检查清单，等待释放')
  await input.dispatchEvent('compositionstart')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true })
  await input.dispatchEvent('compositionend')
  await expect(input).toHaveValue('任务：整理交付检查清单，等待释放')
  expect(calls).toHaveLength(0)
  await input.press('Shift+Enter')
  await expect(input).toHaveValue(/\n$/)
  await click(page, '发送')
  await expect.poll(() => calls.length).toBe(1)
  await expect(page.getByRole('button', { name: '停止当前回复', exact: true })).toBeVisible()
  await input.fill('补充：请在第二点加上负责人。')
  await click(page, '排队发送')
  const queue = page.getByRole('region', { name: '待处理消息' })
  await expect(queue).toContainText('已接收')
  await expect(queue).toContainText('当前回复结束后依次处理')
  await expect(page.locator('.message--owner').filter({ hasText: '补充：' })).toHaveCount(0)
  await input.fill(multiline)
  await expect.poll(() => input.evaluate((node) => node.clientHeight)).toBeGreaterThan(150)
  await select(page, '交付审阅员')
  await expect(input).toHaveValue(''); await input.fill('审阅员的独立草稿')
  await select(page, '管家'); await expect(input).toHaveValue(multiline)
  const metrics: unknown[] = []
  for (const [width, height] of [[1440, 900], [1920, 1080], [3840, 2160], [1100, 760]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await expect(page.locator('.send-button')).toBeInViewport()
    await expect(queue).toBeVisible()
    const composerVisual = await auditVisuals(page.locator('.composer'))
    const queueVisual = await auditVisuals(queue)
    expect(composerVisual.minFontSize).toBeGreaterThanOrEqual(12)
    expect(queueVisual.minFontSize).toBeGreaterThanOrEqual(12)
    expect(composerVisual.minContrast).toBeGreaterThanOrEqual(4.5)
    expect(queueVisual.minContrast).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: join(output, `after-light-${width}x${height}.png`) })
    metrics.push({ composerVisual, queueVisual, ...await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
      const shell = document.querySelector<HTMLElement>('.workbench-shell')!
      const canvas = document.querySelector<HTMLCanvasElement>('.world-canvas-host canvas')!
      return { viewport: [innerWidth, innerHeight], inputHeight: input.clientHeight, inputScroll: input.scrollHeight, overflow: shell.scrollWidth - shell.clientWidth, canvas: canvas?.getBoundingClientRect().toJSON() }
    }) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await click(page, '设置'); await click(page, '黑夜'); await click(page, '保存外观设置')
  await expect(page.locator('html')).toHaveAttribute('data-resolved-color-scheme', 'dark')
  await page.screenshot({ path: join(output, 'after-dark-1440x900.png') })
  await daylight(page)
  release?.()
  await expect.poll(() => calls.length).toBe(2)
  await expect(page.locator('.message:not(.message--owner)').filter({ hasText: '核对来源，并标明负责人' })).toHaveCount(1)
  await expect(page.locator('.message--streaming')).toHaveCount(0)
  await expect(queue).toHaveCount(0)
  expect(calls.map((call) => call.prompt)).toEqual(['任务：整理交付检查清单，等待释放', '补充：请在第二点加上负责人。'])
  const original = page.locator('.message:not(.message--owner)').filter({ hasText: '交付检查清单' })
  await original.getByRole('button', { name: '回复操作', exact: true }).click()
  await page.getByRole('menuitem', { name: /将回复保存为文档/ }).click()
  await original.getByRole('button', { name: '查看文档', exact: true }).click()
  const center = page.getByRole('region', { name: '交付检查清单产物详情' })
  await expect(center.locator('.artifact-markdown-reader')).toContainText('核对交付内容与来源')
  await page.screenshot({ path: join(output, 'delivery-document-1440x900.png') })
  const worldId = calls[0]!.request.agent.worldId
  const firstTurnId = calls[0]!.request.workTurnId!
  await expect.poll(() => server.work.list(worldId).some((task) => task.sourceWorkTurnId === firstTurnId)).toBe(true)
  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '任务')
  const panel = page.getByRole('region', { name: '任务工作台' })
  await expect(panel.getByRole('button', { name: '确认完成', exact: true })).toBeVisible()
  const count = calls.length
  await panel.getByRole('button', { name: '确认完成', exact: true }).click()
  await expect(panel.locator('.task-source h3')).toHaveText('已确认完成')
  expect(calls.length).toBe(count)
  const confirmed = server.work.list(worldId).find((task) => task.status === 'completed')!
  expect(server.work.detail(confirmed.id).runs).toEqual([])
  await page.screenshot({ path: join(output, 'delivery-accepted-1440x900.png') })
  await page.goto('about:blank'); await server.close(); server = await createCyberServer(options()); await server.start(); await page.goto(origin)
  await select(page, '管家'); await expect(input).toHaveValue(multiline)
  expect(server.work.detail(confirmed.id).task.status).toBe('completed')
  expect(server.artifacts.list(worldId)).toHaveLength(1)
  await select(page, '交付审阅员'); await expect(input).toHaveValue('审阅员的独立草稿')
  await writeFile(join(output, 'delivery-evidence.json'), JSON.stringify({ metrics, calls: calls.map(({ prompt, request }) => ({ prompt, sessionId: request.conversationId, workTurnId: request.workTurnId, agentRunId: request.agentRunId })), confirmedTask: confirmed.id, model: 'deterministic test runtime', console: issues }, null, 2))
  expect(issues).toEqual([])
})

test('retains rejected text and attachments across navigation and refresh without replacing newer drafts', async ({ page }) => {
  test.setTimeout(60_000)
  await daylight(page)
  const input = page.locator('.composer textarea')
  await input.fill('发送失败后应恢复这段要求'); await upload(page)
  let reject!: () => void
  const gate = new Promise<void>((resolve) => { reject = resolve })
  await page.route('**/api/worlds/*/chat', async (route) => { await gate; await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_prompt', message: '测试：消息校验失败，请修改要求后重试。' } }) }) })
  await click(page, '发送')
  await expect(page.getByRole('region', { name: '待确认的发送' })).toContainText('正在发送')
  await input.fill('发送期间的新草稿')
  await select(page, '交付审阅员'); await input.fill('另一会话的内容')
  reject()
  await expect(page.getByRole('region', { name: '待确认的发送' })).toHaveCount(0)
  await page.reload(); await select(page, '管家')
  await expect(input).toHaveValue('发送期间的新草稿')
  const recovery = page.getByRole('region', { name: '待确认的发送' })
  await expect(recovery).toContainText('发送失败，内容已保留')
  await recovery.locator('summary').click()
  await expect(recovery).toContainText('验收要求.txt')
  await expect(recovery.getByRole('button', { name: '恢复到输入框' })).toBeDisabled()
  await input.fill('')
  await page.screenshot({ path: join(output, 'after-failure-1440x900.png') })
  await click(page, '恢复到输入框')
  await expect(input).toHaveValue('发送失败后应恢复这段要求')
  await expect(page.locator('.composer-attachments')).toContainText('验收要求.txt')
  await page.unroute('**/api/worlds/*/chat')
  await click(page, '发送')
  await expect.poll(() => calls.length).toBe(1)
  await expect(recovery).toHaveCount(0)
  await select(page, '交付审阅员'); await expect(input).toHaveValue('另一会话的内容')
  expect(issues.filter((issue) => !issue.includes('422'))).toEqual([])
})

test('retries a lost acceptance with the original body after reload and executes exactly once', async ({ page }) => {
  test.setTimeout(60_000)
  const bodies: string[] = []
  let loseResponse = true
  await page.route('**/api/worlds/*/chat', async (route) => {
    bodies.push(route.request().postData()!)
    if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort('connectionreset') }
    else await route.continue()
  })
  await page.locator('.composer textarea').fill('请核对资料，接收响应将被中断')
  await click(page, '发送')
  await expect(page.getByRole('region', { name: '待确认的发送' })).toContainText('提交尚未确认')
  await expect.poll(() => calls.length).toBe(1)
  await page.reload(); await select(page, '管家')
  await expect(page.getByRole('region', { name: '待确认的发送' })).toContainText('内容已保留')
  await click(page, '重试提交')
  await expect(page.getByRole('region', { name: '待确认的发送' })).toHaveCount(0)
  expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(calls).toHaveLength(1)
  const messages = server.store.listMessages(calls[0]!.request.conversationId)
  expect(messages.filter((message) => message.kind === 'user')).toHaveLength(1)
  expect(messages.filter((message) => message.kind === 'assistant')).toHaveLength(1)
  await writeFile(join(output, 'retry-evidence.json'), JSON.stringify({ clientTurnId: JSON.parse(bodies[0]!).clientTurnId, requests: bodies.length, runtimeCalls: calls.length, userMessages: 1, assistantMessages: 1, console: issues }, null, 2))
  expect(issues.filter((issue) => !issue.includes('ERR_CONNECTION_RESET'))).toEqual([])
})

test('keeps a late acceptance from bringing a completed turn back into the waiting queue', async ({ page }) => {
  test.setTimeout(45_000)
  let acknowledge!: () => void
  const gate = new Promise<void>((resolve) => { acknowledge = resolve })
  await page.route('**/api/worlds/*/chat', async (route) => {
    const response = await route.fetch()
    await gate
    await route.fulfill({ response })
  })
  await page.locator('.composer textarea').fill('检查这份资料并回复')
  await click(page, '发送')
  await expect(page.getByRole('region', { name: '待确认的发送' })).toContainText('正在发送')
  await expect(page.locator('.message:not(.message--owner)').filter({ hasText: '交付检查清单' })).toHaveCount(1)
  await expect(page.locator('.message--streaming')).toHaveCount(0)
  acknowledge()
  await expect(page.getByRole('region', { name: '待确认的发送' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '待处理消息' })).toHaveCount(0)
  await expect(page.locator('.stream-state')).toHaveCount(0)
  expect(calls).toHaveLength(1)
  expect(issues).toEqual([])
})

test('keeps the reading position when a new reply arrives and contains long Markdown in the message', async ({ page }) => {
  test.setTimeout(60_000)
  await daylight(page)
  await page.locator('.composer textarea').fill('请给出长回复供阅读')
  await click(page, '发送')
  await expect(page.locator('.message:not(.message--owner)').filter({ hasText: '第 32 项检查' })).toBeVisible()
  await expect(page.locator('.message--streaming')).toHaveCount(0)
  const scroll = page.locator('.message-scroll')
  await scroll.hover(); await page.mouse.wheel(0, -1400)
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible()
  // Wait for the browser's wheel scroll to settle before recording its anchor.
  await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(500)
  const anchor = await scroll.evaluate((node) => node.scrollTop)
  const request = calls[0]!.request
  await page.request.post(`${origin}/api/worlds/${request.agent.worldId}/chat`, { data: { employeeIds: [request.agent.id], sessionId: request.conversationId, prompt: '补充：后台送达一条新结果', queueMode: 'normal', clientTurnId: 'background-reading-check' } })
  await expect(page.locator('.message:not(.message--owner)').filter({ hasText: '核对来源，并标明负责人' })).toHaveCount(1)
  expect(Math.abs(await scroll.evaluate((node) => node.scrollTop) - anchor)).toBeLessThan(5)
  expect(await page.locator('.workbench-shell').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
  expect(await page.locator('.markdown-body pre').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true)
  await page.screenshot({ path: join(output, 'long-reading-1440x900.png') })
  expect(Math.abs(await scroll.evaluate((node) => node.scrollTop) - anchor)).toBeLessThan(5)
  await click(page, '回到最新消息')
  await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(64)
  const visual = await auditVisuals(page.locator('.composer'))
  expect(visual.minFontSize).toBeGreaterThanOrEqual(12)
  expect(visual.minContrast).toBeGreaterThanOrEqual(4.5)
  await writeFile(join(output, 'reading-evidence.json'), JSON.stringify({ anchor, visual, console: issues }, null, 2))
  expect(issues).toEqual([])
})
