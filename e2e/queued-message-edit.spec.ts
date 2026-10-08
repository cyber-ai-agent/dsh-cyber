import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest, ChatAttachment } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

const firstPrompt = '第一条任务等待测试明确放行'
const queuedPrompt = '请修改这条排队消息。\n保留第二行和附件。'
const attachmentName = 'queued-original.txt'
const secondName = '排队消息审阅员'
const otherWorldName = '排队编辑隔离世界'
const otherEmployeeName = '另一世界审阅员'
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
let server: CyberServer
let runtime: ControlledRuntime
let root = ''
let origin = ''
let worldId = ''
let worldName = ''
let employeeId = ''
let employeeName = ''
let consoleIssues: string[] = []
let expectedConsoleIssue: RegExp | undefined

interface QueueItem {
  id: string
  serverQueueId: string
  sessionId: string
  workTurnId: string
  status: string
  content?: string
  attachments?: ChatAttachment[]
}

interface QueuedMessage {
  queued: QueueItem
  attachments: ChatAttachment[]
}

test.beforeEach(async ({ page }) => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  expectedConsoleIssue = undefined
  consoleIssues = []
  attachAppConsoleRecorder(page, consoleIssues)
  root = await mkdtemp(join(tmpdir(), 'cyber-queued-edit-e2e-'))
  runtime = new ControlledRuntime()
  server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    webRoot: process.env.DSH_QUEUED_EDIT_WEB_ROOT ?? join(process.cwd(), 'packages/web/dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
  })
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  worldId = world.id
  worldName = world.name
  employeeId = employee.id
  employeeName = employee.displayName
  server.store.recruitEmployee({ workspaceId: workspace.id, worldId, blueprintId: 'core.butler', blueprintVersion: 1, displayName: secondName })
  const other = server.store.createWorld({ workspaceId: workspace.id, name: otherWorldName, templateId: 'personal-world' })
  server.store.recruitEmployee({ workspaceId: workspace.id, worldId: other.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: otherEmployeeName })
  origin = (await server.start()).origin
})

test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach('console', {
    body: Buffer.from(consoleIssues.join('\n') || 'No console errors or warnings.'),
    contentType: 'text/plain',
  })
  // Close the browser connection before server cleanup to avoid recording SSE
  // disconnects caused solely by shutting down this test's private server.
  await page.close()
  runtime?.releaseFirst()
  await server?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
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
  return page.locator('.composer textarea')
}

async function uploadFile(page: Page, name: string) {
  const button = page.getByRole('button', { name: '添加附件', exact: true })
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  const chooserPromise = page.waitForEvent('filechooser')
  await button.click()
  await (await chooserPromise).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(`附件内容：${name}`) })
  await expect(page.locator('.composer-attachment--ready')).toContainText(name)
}

async function submitComposer(page: Page, buttonName: string) {
  const button = page.getByRole('button', { name: buttonName, exact: true })
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/worlds/${worldId}/chat`))
  await button.click()
  const response = await responsePromise
  expect(response.status()).toBe(202)
  await expect(page.locator('.composer textarea')).toHaveValue('')
  return response
}

async function queueFromColdPage(page: Page): Promise<QueuedMessage> {
  // No pre-seeded browser storage or API-created messages: exercise the actual
  // initial App load, visible conversation, attachment chooser and Send flow.
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const composer = await selectConversation(page)
  await composer.fill(firstPrompt)
  await submitComposer(page, '发送')
  await expect.poll(() => runtime.calls.length).toBe(1)
  await composer.fill(queuedPrompt)
  await expect(composer).toHaveValue(queuedPrompt)
  await uploadFile(page, attachmentName)
  const response = await submitComposer(page, '排队发送')
  const request = response.request().postDataJSON() as { attachments: ChatAttachment[] }
  expect(request.attachments).toHaveLength(1)
  await expect(queueRegion(page)).toContainText(queuedPrompt)
  await expect(page.locator('.composer-attachments')).toHaveCount(0)
  const queue = await getQueue()
  const queued = queue.find((item) => item.status === 'queued' && item.content === queuedPrompt)
  expect(queued).toBeDefined()
  return { queued: queued!, attachments: request.attachments }
}

function queueRegion(page: Page) {
  return page.getByRole('region', { name: '待处理消息', exact: true })
}

async function openEditMenu(page: Page) {
  const menuButton = queueRegion(page).getByRole('button', { name: /排队消息操作/ })
  await expect(menuButton).toBeVisible()
  await expect(menuButton).toBeEnabled()
  await menuButton.click()
  const edit = page.getByRole('menuitem', { name: '编辑排队消息', exact: true })
  await expect(edit).toBeVisible()
  return edit
}

async function editQueuedMessage(page: Page) {
  const edit = await openEditMenu(page)
  await expect(edit).toBeEnabled()
  await edit.click()
}

function deleteUrl(queued: QueueItem) {
  return `${origin}/api/worlds/${worldId}/chat-queue/${queued.serverQueueId}`
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function delayCancellation(page: Page, queued: QueueItem) {
  const started = deferred()
  const released = deferred()
  let deleteCount = 0
  await page.route(deleteUrl(queued), async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    deleteCount += 1
    started.resolve()
    await released.promise
    await route.continue()
  })
  return { started: started.promise, release: released.resolve, deleteCount: () => deleteCount }
}

async function getQueue(): Promise<QueueItem[]> {
  const response = await fetch(`${origin}/api/worlds/${worldId}/chat-queue`)
  expect(response.ok).toBe(true)
  return (await response.json() as { items: QueueItem[] }).items
}

async function expectRestored(page: Page) {
  await expect(page.locator('.composer textarea')).toHaveValue(queuedPrompt)
  await expect(page.locator('.composer-attachment--ready')).toHaveCount(1)
  await expect(page.locator('.composer-attachment--ready')).toContainText(attachmentName)
  await expect(queueRegion(page)).toHaveCount(0)
}

async function expectCancelledNeverRuns(queued: QueueItem) {
  await expect.poll(() => server.store.getConversationQueueEntry(queued.serverQueueId)?.status).toBe('cancelled')
  runtime.releaseFirst()
  // Completing another real turn in the same session proves the scheduler has
  // progressed beyond cancellation, rather than only checking an idle moment.
  const response = await fetch(`${origin}/api/worlds/${worldId}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employeeIds: [employeeId], sessionId: queued.sessionId, prompt: '验证撤回后的队列仍继续执行', queueMode: 'normal', clientTurnId: `sentinel-${queued.id}` }),
  })
  expect(response.status).toBe(202)
  const next = await response.json() as { workTurnId: string }
  await expect.poll(() => server.store.getWorkTurn(next.workTurnId)?.status).toBe('completed')
  expect(runtime.calls.some((call) => call.workTurnId === queued.workTurnId)).toBe(false)
  expect(server.store.getConversationQueueEntry(queued.serverQueueId)?.status).toBe('cancelled')
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

for (const reloadBeforeEdit of [false, true]) {
  test(`restores text and attachment exactly once after ${reloadBeforeEdit ? 'reloading the queue' : 'initial App load'}`, async ({ page }, testInfo) => {
    const { queued, attachments } = await queueFromColdPage(page)
    const restoredQueue = (await getQueue()).find((item) => item.id === queued.id)!
    if (reloadBeforeEdit) {
      await page.reload()
      await selectConversation(page)
    }
    await expect(queueRegion(page)).toContainText(queuedPrompt)
    const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url() === deleteUrl(queued))
    await editQueuedMessage(page)
    expect((await deletion).status()).toBe(200)
    expect(server.store.getConversationQueueEntry(queued.serverQueueId)?.status).toBe('cancelled')
    await expectRestored(page)
    expect(restoredQueue.attachments).toEqual(attachments)
    await capture(page, testInfo, 'queued-message-restored')
    await page.reload()
    await selectConversation(page)
    await expectRestored(page)
    await expect(page.getByRole('button', { name: '恢复撤回消息', exact: true })).toHaveCount(0)
    await expectCancelledNeverRuns(queued)
  })
}

for (const failure of ['conflict', 'network'] as const) {
  test(`keeps the queue and empty composer unchanged when cancellation fails with ${failure}`, async ({ page }) => {
    const { queued } = await queueFromColdPage(page)
    expectedConsoleIssue = failure === 'conflict'
      ? /^\[console:error\] Failed to load resource: the server responded with a status of 409 /
      : /^\[console:error\] Failed to load resource: net::ERR_FAILED$/
    let deleteCount = 0
    await page.route(deleteUrl(queued), async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deleteCount += 1
      if (failure === 'network') await route.abort('failed')
      else await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'queue_entry_not_queued', message: '排队消息状态已变化，请重试。' } }) })
    })
    await editQueuedMessage(page)
    await expect(page.getByRole('alert').filter({ hasText: failure === 'conflict' ? '排队消息状态已变化，请重试。' : /fetch|网络|请求|撤销|撤回/i })).toBeVisible()
    expect(deleteCount).toBe(1)
    await expect(queueRegion(page)).toContainText(queuedPrompt)
    await expect(page.locator('.composer textarea')).toHaveValue('')
    await expect(page.locator('.composer-attachments')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '恢复撤回消息', exact: true })).toHaveCount(0)
    expect(server.store.getConversationQueueEntry(queued.serverQueueId)?.status).toBe('queued')
    expect(runtime.calls).toHaveLength(1)
  })
}

for (const occupiedBy of ['text', 'attachment'] as const) {
  test(`does not request cancellation while the composer already contains ${occupiedBy}`, async ({ page }) => {
    const { queued } = await queueFromColdPage(page)
    let deleteCount = 0
    page.on('request', (request) => { if (request.method() === 'DELETE' && request.url() === deleteUrl(queued)) deleteCount += 1 })
    if (occupiedBy === 'text') await page.locator('.composer textarea').fill('已有草稿，不能被覆盖')
    else await uploadFile(page, 'existing-draft.txt')
    await editQueuedMessage(page)
    await expect(page.getByRole('alert')).toContainText('请先发送或清空当前草稿，再编辑排队消息。')
    await expect(queueRegion(page)).toContainText(queuedPrompt)
    await expect(page.locator('.composer textarea')).toHaveValue(occupiedBy === 'text' ? '已有草稿，不能被覆盖' : '')
    if (occupiedBy === 'attachment') await expect(page.locator('.composer-attachments')).toContainText('existing-draft.txt')
    expect(deleteCount).toBe(0)
    expect(server.store.getConversationQueueEntry(queued.serverQueueId)?.status).toBe('queued')
  })
}

test('waits for confirmed cancellation and coalesces repeated Edit attempts into one DELETE', async ({ page }) => {
  const { queued } = await queueFromColdPage(page)
  const cancellation = await delayCancellation(page, queued)
  try {
    await editQueuedMessage(page)
    await cancellation.started
    await expect(page.locator('.composer textarea')).toHaveValue('')
    await expect(page.locator('.composer-attachments')).toHaveCount(0)
    await expect(queueRegion(page)).toContainText(queuedPrompt)
    expect(server.store.getConversationQueueEntry(queued.serverQueueId)?.status).toBe('queued')
    const repeatedEdit = await openEditMenu(page)
    if (await repeatedEdit.isEnabled()) await repeatedEdit.click()
    else {
      await expect(repeatedEdit).toBeDisabled()
      await page.keyboard.press('Escape')
    }
    const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url() === deleteUrl(queued))
    cancellation.release()
    expect((await deletion).status()).toBe(200)
    await expectRestored(page)
    expect(cancellation.deleteCount()).toBe(1)
    await expectCancelledNeverRuns(queued)
  } finally { cancellation.release() }
})

for (const navigation of ['conversation', 'world'] as const) {
  test(`restores only the original owner after switching ${navigation} during cancellation`, async ({ page }) => {
    const { queued } = await queueFromColdPage(page)
    const cancellation = await delayCancellation(page, queued)
    try {
      await editQueuedMessage(page)
      await cancellation.started
      if (navigation === 'world') {
        await page.locator('.topbar-world-switcher > summary').click()
        await page.getByRole('menuitemradio').filter({ hasText: otherWorldName }).click()
      }
      const destination = navigation === 'world' ? otherEmployeeName : secondName
      const composer = await selectConversation(page, destination)
      await composer.fill('另一个会话自己的草稿')
      await uploadFile(page, 'other-owner.txt')
      const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url() === deleteUrl(queued))
      cancellation.release()
      expect((await deletion).status()).toBe(200)
      await expect(composer).toHaveValue('另一个会话自己的草稿')
      await expect(page.locator('.composer-attachment--ready')).toHaveCount(1)
      await expect(page.locator('.composer-attachments')).toContainText('other-owner.txt')
      await expect(page.locator('.composer')).not.toContainText(attachmentName)
      if (navigation === 'world') {
        await page.locator('.topbar-world-switcher > summary').click()
        await page.getByRole('menuitemradio').filter({ hasText: worldName }).click()
      }
      await selectConversation(page)
      await expectRestored(page)
      await page.reload()
      await selectConversation(page)
      await expectRestored(page)
      await expectCancelledNeverRuns(queued)
    } finally { cancellation.release() }
  })
}

test('preserves newer text and attachments with durable explicit recovery after delayed cancellation', async ({ page }, testInfo) => {
  const { queued } = await queueFromColdPage(page)
  const cancellation = await delayCancellation(page, queued)
  try {
    await editQueuedMessage(page)
    await cancellation.started
    const composer = page.locator('.composer textarea')
    await composer.fill('撤回等待期间新写的内容')
    await uploadFile(page, 'newer-draft.txt')
    const deletion = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url() === deleteUrl(queued))
    cancellation.release()
    expect((await deletion).status()).toBe(200)
    const restore = page.getByRole('button', { name: '恢复撤回消息', exact: true })
    await expect(restore).toBeVisible()
    await expect(restore).toBeDisabled()
    await expect(composer).toHaveValue('撤回等待期间新写的内容')
    await expect(page.locator('.composer-attachments')).toContainText('newer-draft.txt')
    await expect(page.locator('.composer')).not.toContainText(attachmentName)
    await expect(queueRegion(page)).toHaveCount(0)
    await capture(page, testInfo, 'queued-message-recovery')
    await page.reload()
    await selectConversation(page)
    await expect(restore).toBeVisible()
    await expect(restore).toBeDisabled()
    await expect(composer).toHaveValue('撤回等待期间新写的内容')
    await expect(page.locator('.composer-attachments')).toContainText('newer-draft.txt')
    await composer.press('ControlOrMeta+A')
    await composer.press('Backspace')
    await expect(composer).toHaveValue('')
    await expect(restore).toBeDisabled()
    const remove = page.getByRole('button', { name: '移除附件 newer-draft.txt', exact: true })
    await expect(remove).toBeVisible()
    await expect(remove).toBeEnabled()
    await remove.click()
    await expect(page.locator('.composer-attachments')).toHaveCount(0)
    await expect(restore).toBeEnabled()
    await restore.click()
    await expectRestored(page)
    await expect(restore).toHaveCount(0)
    await page.reload()
    await selectConversation(page)
    await expectRestored(page)
    await expect(restore).toHaveCount(0)
    expect(cancellation.deleteCount()).toBe(1)
    await expectCancelledNeverRuns(queued)
  } finally { cancellation.release() }
})

class ControlledRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []
  readonly #first = deferred()

  releaseFirst() { this.#first.resolve() }

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    if (this.calls.length === 1) await this.#first.promise
    const content = '测试任务已完成。'
    request.onEvent?.({ kind: 'assistant.message', source: 'queued-edit-e2e', sourceSessionId: request.conversationId, content, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'queued-edit-e2e', sourceSessionId: request.conversationId, metadata: {} })
    return { agentSessionId: request.conversationId, finalResponse: content, eventCount: 2 }
  }

  async abortRun() { this.releaseFirst() }
  async close() { this.releaseFirst() }
}
