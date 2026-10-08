import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { WorldPackageInstanceService } from '../packages/server/lib/services/world-package-instance-service.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

const prompt = '请聊聊这条消息'
const secondName = '另一个会话'
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
const originalPackages = WorldPackageInstanceService.prototype.listRuntimePackages
let server: CyberServer
let root = ''
let origin = ''
let worldId = ''
let employeeName = ''
let runtime: FailureRuntime
let consoleIssues: string[] = []
let expectedConsoleIssue: RegExp | undefined
let releasePreparation: (() => void) | undefined

class FailureRuntime implements AgentRuntimePort {
  calls: AgentTurnRequest[] = []
  fail!: () => void
  finish!: () => void
  readonly failureGate = new Promise<void>((resolve) => { this.fail = resolve })
  readonly finishGate = new Promise<void>((resolve) => { this.finish = resolve })
  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    request.onEvent?.({ kind: 'turn.started', source: 'fixture', sourceSessionId: 'failure-test', metadata: {} })
    request.onEvent?.({ kind: 'text.delta', source: 'fixture', sourceSessionId: 'failure-test', content: '暂未完成的回复', metadata: {} })
    await this.failureGate
    request.onEvent?.({ kind: 'turn.failed', source: 'fixture', sourceSessionId: 'failure-test', failed: true, metadata: { failure: 'provider-authentication', statusCode: 401 } })
    await this.finishGate
    return { agentSessionId: 'failure-test', finalResponse: '', eventCount: 3 }
  }
  async close() { this.fail(); this.finish() }
}

test.beforeEach(async ({ page }) => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  consoleIssues = []
  expectedConsoleIssue = undefined
  releasePreparation = undefined
  attachAppConsoleRecorder(page, consoleIssues)
  root = await mkdtemp(join(tmpdir(), 'cyber-failure-feedback-e2e-'))
  runtime = new FailureRuntime()
  server = await createCyberServer({ stateRoot: root, workspacePath: root, webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, bootstrapDefaultWorld: true, runtime })
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  worldId = world.id
  employeeName = employee.displayName
  server.store.recruitEmployee({ workspaceId: workspace.id, worldId, blueprintId: 'core.butler', blueprintVersion: 1, displayName: secondName })
  origin = (await server.start()).origin
})

test.afterEach(async () => {
  WorldPackageInstanceService.prototype.listRuntimePackages = originalPackages
  releasePreparation?.()
  runtime.fail()
  runtime.finish()
  await server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
  if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog
  expect(consoleIssues.filter((issue) => !expectedConsoleIssue?.test(issue))).toEqual([])
})

async function selectConversation(page: Page, name = employeeName) {
  const entry = page.getByRole('button', { name: `与${name}私聊`, exact: true })
  await expect(entry).toBeVisible()
  await expect(entry).toBeEnabled()
  await entry.click()
  await expect(page.locator('.chat-header h1')).toContainText(name)
}

async function sendFromComposer(page: Page, expectBusy = true) {
  await page.locator('.composer textarea').fill(prompt)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeVisible()
  await expect(send).toBeEnabled()
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/worlds/${worldId}/chat`))
  await send.click()
  const response = await responsePromise
  expect(response.status()).toBe(202)
  const receipt = await response.json() as { session: { id: string }; workTurnId: string }
  await expect(page.locator('.composer textarea')).toHaveValue('')
  if (expectBusy) await expect(page.locator('.message-scroll')).toHaveAttribute('aria-busy', 'true')
  return receipt
}

async function expectSettled(page: Page, preparation: boolean) {
  await expect(page.locator('.chat-system-notice')).toHaveCount(1)
  await expect(page.locator('.chat-system-notice')).toContainText('本次处理未完成：')
  await expect(page.locator('.chat-system-notice')).toContainText(preparation ? '处理消息时发生错误' : 'API 密钥被模型服务拒绝')
  await expect(page.locator('.message-scroll')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.message--streaming')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '停止当前回复', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '待处理消息' })).toHaveCount(0)
  await expect(page.locator('.message--owner')).toHaveCount(1)
  await expect(page.locator('.message--owner')).toContainText(prompt)
  await expect(page.locator('.message-scroll')).not.toContainText('secret-fixture-value')
}

for (const scenario of ['live-provider', 'disconnected-provider', 'disconnected-preparation', 'switched-owner'] as const) {
  test(`keeps one accepted failure visible after ${scenario}, reload and history`, async ({ page }, testInfo) => {
    const disconnected = scenario !== 'live-provider'
    const preparation = scenario === 'disconnected-preparation'
    if (disconnected) {
      // The app must recover from durable HTTP reads even when no runtime event arrives.
      await page.route('**/api/worlds/*/live', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': disconnected fixture\n\n' }))
    }
    await page.goto(origin)
    await expect(page.locator('.workbench-shell')).toBeVisible()
    await selectConversation(page)
    if (preparation) {
      const gate = new Promise<void>((resolve) => { releasePreparation = resolve })
      WorldPackageInstanceService.prototype.listRuntimePackages = async function (id) {
        if (id !== worldId) return originalPackages.call(this, id)
        await gate
        throw new Error('preparation secret-fixture-value /private/settings.json')
      }
    }
    const receipt = await sendFromComposer(page)
    if (scenario === 'switched-owner') {
      await selectConversation(page, secondName)
      await page.locator('.composer textarea').fill('另一会话的独立草稿')
    }
    if (preparation) releasePreparation!()
    else {
      await expect.poll(() => runtime.calls.length).toBe(1)
      runtime.fail()
      if (!disconnected) {
        // Force the runtime SSE to precede the durable failure by more than one poll.
        await expect(page.locator('.chat-system-notice')).toContainText('发送失败：')
        await page.waitForTimeout(1_100)
      }
      runtime.finish()
    }
    await expect.poll(() => server.store.getWorkTurn(receipt.workTurnId)?.status).toBe('failed')
    if (scenario === 'switched-owner') {
      await expect(page.locator('.chat-system-notice')).toHaveCount(0)
      await expect(page.locator('.composer textarea')).toHaveValue('另一会话的独立草稿')
      await selectConversation(page)
    }
    await expectSettled(page, preparation)
    const messages = server.store.listMessages(receipt.session.id)
    const notices = messages.filter((message) => message.metadata.control === 'failure')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.metadata.workTurnId).toBe(receipt.workTurnId)
    expect(runtime.calls).toHaveLength(preparation ? 0 : 1)
    WorldPackageInstanceService.prototype.listRuntimePackages = originalPackages
    await page.reload()
    await expect(page.locator('.workbench-shell')).toBeVisible()
    await selectConversation(page)
    await expectSettled(page, preparation)
    await page.getByRole('button', { name: '查看历史消息', exact: true }).click()
    const history = page.getByRole('dialog', { name: '历史消息', exact: true })
    await expect(history).toBeVisible()
    await expect(history.getByText(/本次处理未完成：/)).toHaveCount(1)
    await page.getByRole('button', { name: '关闭历史消息', exact: true }).click()
    await expectSettled(page, preparation)
    await page.screenshot({ path: testInfo.outputPath('durable-failure.png') })
    expect(runtime.calls).toHaveLength(preparation ? 0 : 1)
    expect(server.store.listMessages(receipt.session.id)).toEqual(messages)
  })
}


for (const transientFailure of [false, true]) test(`re-reads a fast failure after queue disappearance${transientFailure ? ', an overlapping old read and a transient 503' : ''}`, async ({ page }, testInfo) => {
  if (transientFailure) expectedConsoleIssue = /Failed to load resource: the server responded with a status of 503/
  await page.route('**/api/worlds/*/live', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': disconnected fixture\n\n' }))
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await selectConversation(page)
  let releaseEarlyRead!: () => void
  const earlyRead = new Promise<void>((resolve) => { releaseEarlyRead = resolve })
  let earlyReads = 0
  let finalReads = 0
  let blockedReads = 0
  let releaseDelayedEarly!: () => void
  const delayedEarly = new Promise<void>((resolve) => { releaseDelayedEarly = resolve })
  await page.route('**/api/sessions/*/messages?*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (body.items.some((item: { content: string }) => item.content === prompt)) {
      if (body.items.some((item: { metadata: { control?: string } }) => item.metadata.control === 'failure')) {
        finalReads += 1
        if (transientFailure && blockedReads === 0) {
          blockedReads += 1
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'temporary offline' } }) })
          // The earlier 200 arrives after terminal reconciliation ownership was
          // recorded. It must not clear the retry owner with its stale transcript.
          releaseDelayedEarly()
          return
        }
      } else {
        earlyReads += 1
        releaseEarlyRead()
        if (transientFailure && earlyReads === 1) await delayedEarly
      }
    }
    await route.fulfill({ response })
  })
  await page.route(`**/api/worlds/${worldId}/chat`, async (route) => {
    const response = await route.fetch()
    await expect.poll(() => runtime.calls.length).toBe(1)
    await route.fulfill({ response })
  })
  let settledQueueReads = 0
  await page.route(`**/api/worlds/${worldId}/chat-queue`, async (route) => {
    if (runtime.calls.length === 0) { await route.continue(); return }
    await earlyRead
    runtime.fail()
    runtime.finish()
    await expect.poll(() => server.store.getWorkTurn(runtime.calls[0]!.workTurnId!)?.status).toBe('failed')
    const response = await route.fetch()
    expect((await response.json()).items).toHaveLength(0)
    settledQueueReads += 1
    await route.fulfill({ response })
  })
  await sendFromComposer(page, false)
  if (transientFailure) {
    await expect.poll(() => blockedReads).toBe(1)
    await expect(page.locator('.message-scroll')).toHaveAttribute('aria-busy', 'false')
  }
  await expectSettled(page, false)
  expect(earlyReads).toBeGreaterThan(0)
  expect(settledQueueReads).toBeGreaterThan(0)
  expect(finalReads).toBeGreaterThan(transientFailure ? 1 : 0)
  expect(runtime.calls).toHaveLength(1)
  await page.screenshot({ path: testInfo.outputPath('fast-durable-failure.png') })
})
