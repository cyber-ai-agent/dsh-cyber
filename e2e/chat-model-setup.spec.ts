import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

// Controlled HTTP provider; the app and the normal Harness subprocess are real.
// The canned reply proves routing and UI delivery, not model/task quality.
const fixtureReply = '这是本地 HTTP 测试服务的固定简报，用于验证连接和文档保存。'
const modelId = 'readiness-fixture-model'
let server: CyberServer
let root = ''
let origin = ''
let providerOrigin = ''
let provider: Server
let workspaceId = ''
let worldId = ''
let employeeId = ''
let employeeName = ''
let secondEmployeeName = '另一个角色'
let chatRequests = 0
let modelListFails = false
let issues: string[] = []
let expectedIssue: RegExp | undefined
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
const previousKey = process.env.DEEPSEEK_API_KEY

test.beforeEach(async ({ page }) => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  delete process.env.DEEPSEEK_API_KEY
  issues = []; chatRequests = 0; modelListFails = false; expectedIssue = undefined
  attachAppConsoleRecorder(page, issues)
  provider = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    if (req.url === '/v1/models') {
      res.writeHead(modelListFails ? 503 : 200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(modelListFails ? { error: 'fixture directory unavailable' } : { object: 'list', data: [{ id: modelId, object: 'model', owned_by: 'local-fixture' }] })); return
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(text)
      if (body.stream) {
        chatRequests++
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const base = { id: 'fixture-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId }
        res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: fixtureReply }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'fixture-classification', object: 'chat.completion', model: modelId, choices: [{ index: 0, message: { role: 'assistant', content: '{"isTask":false}' }, finish_reason: 'stop' }] }))
      }
      return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  root = await mkdtemp(join(tmpdir(), 'cyber-model-setup-e2e-'))
  server = await createCyberServer({ stateRoot: root, workspacePath: root, webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, bootstrapDefaultWorld: true })
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  workspaceId = workspace.id; worldId = world.id; employeeId = employee.id; employeeName = employee.displayName
  server.store.recruitEmployee({ workspaceId, worldId, blueprintId: 'core.butler', blueprintVersion: 1, displayName: secondEmployeeName })
  origin = (await server.start()).origin
})

test.afterEach(async () => {
  await server.close()
  await new Promise<void>((resolve) => provider.close(() => resolve()))
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
  if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL; else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog
  if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey
  expect(issues.filter((issue) => !expectedIssue?.test(issue))).toEqual([])
})

async function openChat(page: Page, name = employeeName) {
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await selectChat(page, name)
}
async function selectChat(page: Page, name: string) {
  const button = page.getByRole('button', { name: `与${name}私聊`, exact: true })
  await expect(button).toBeVisible(); await expect(button).toBeEnabled(); await button.click()
  await expect(page.locator('.chat-header h1')).toContainText(name)
}
async function openSetup(page: Page) {
  const button = page.getByRole('button', { name: '配置对话模型', exact: true })
  await expect(button).toBeVisible(); await button.click()
  await expect(page.getByRole('dialog', { name: 'AI 模型管理中心', exact: true })).toBeVisible()
}
async function fillProvider(page: Page) {
  await page.getByRole('button', { name: '添加服务商', exact: true }).click()
  await page.getByRole('combobox', { name: '选择服务商', exact: true }).selectOption('local')
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('本地测试服务')
  await page.getByRole('textbox', { name: '接口地址 Base URL', exact: true }).fill(`${providerOrigin}/v1`)
}
async function importProvider(page: Page) {
  await fillProvider(page)
  await page.getByRole('button', { name: '保存服务商并获取模型列表' }).click()
  await page.getByRole('button', { name: '保存并导入模型池' }).click()
  await expect(page.getByText('模型已导入，请选择一个用于此对话', { exact: true })).toBeVisible()
}
function saveProfile(name: string, requiredKey = false) {
  return server.store.saveModelProfile({ workspaceId, displayName: name, providerKind: 'openai-compatible-local', baseUrl: `${providerOrigin}/v1`, api: 'openai-completions', modelId, ...(requiredKey ? { credentialEnvName: 'MISSING_READINESS_FIXTURE_KEY' } : {}) })
}

test('clean CLI bootstrap explains setup and preserves draft/attachments through cancel, reopen and conversation switch', async ({ page }, testInfo) => {
  let sends = 0
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith(`/api/worlds/${worldId}/chat`)) sends++ })
  await openChat(page)
  await expect(page.locator('.chat-model-readiness')).toContainText('先连接一个模型')
  await page.locator('.composer textarea').fill('保留这份首次任务草稿')
  await page.locator('.composer input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first task notes') })
  await expect(page.locator('.composer-attachments')).toContainText('notes.txt')
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('01-clean-model-needed.png') })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI 模型管理中心', exact: true })).toBeVisible()
  expect(sends).toBe(0); expect(chatRequests).toBe(0)
  await page.getByRole('button', { name: '返回对话', exact: true }).click()
  await expect(page.locator('.composer textarea')).toHaveValue('保留这份首次任务草稿')
  await expect(page.locator('.composer-attachments')).toContainText('notes.txt')
  await selectChat(page, secondEmployeeName)
  await page.locator('.composer textarea').fill('另一个角色的草稿')
  await selectChat(page, employeeName)
  await expect(page.locator('.composer textarea')).toHaveValue('保留这份首次任务草稿')
  await openSetup(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'AI 模型管理中心', exact: true })).toHaveCount(0)
  await page.reload(); await selectChat(page, employeeName)
  await expect(page.locator('.composer textarea')).toHaveValue('保留这份首次任务草稿')
  await expect(page.locator('.composer-attachments')).toContainText('notes.txt')
  expect(sends).toBe(0)
})

test('imports without probing, explicitly assigns current role, returns to draft and reaches real Harness HTTP path', async ({ page }, testInfo) => {
  await openChat(page)
  await page.locator('.composer textarea').fill('请整理这份测试笔记')
  await openSetup(page); await importProvider(page)
  expect(chatRequests).toBe(0)
  expect(server.store.listModelAssignments(workspaceId)).toHaveLength(0)
  const apply = page.getByRole('button', { name: '用于当前角色并返回对话', exact: true })
  await expect(apply).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('02-imported-explicit-selection.png') })
  await page.getByRole('radio').check()
  await apply.click()
  await expect(page.getByRole('dialog', { name: 'AI 模型管理中心', exact: true })).toHaveCount(0)
  await expect(page.locator('.composer textarea')).toHaveValue('请整理这份测试笔记')
  await expect(page.locator('.chat-model-readiness')).toContainText('角色指定')
  await expect(page.locator('.chat-model-readiness')).toContainText('对话连接未验证')
  expect(server.store.listModelAssignments(workspaceId)).toMatchObject([{ scope: 'employee', scopeId: employeeId }])
  expect(chatRequests).toBe(0)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.message__content').filter({ hasText: fixtureReply })).toBeVisible({ timeout: 30_000 })
  expect(chatRequests).toBe(1)
  await page.getByRole('button', { name: '回复操作', exact: true }).click()
  await page.getByRole('menuitem', { name: /将回复保存为文档/ }).click()
  await expect(page.getByRole('button', { name: '查看文档', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '查看文档', exact: true }).click()
  await expect(page.getByRole('region', { name: /产物详情$/ })).toBeVisible()
  await expect(page.locator('.artifact-markdown-reader')).toContainText(fixtureReply)
  await page.screenshot({ path: testInfo.outputPath('03-first-reply-saved-document.png') })
})

for (const scope of ['workspace', 'world', 'employee'] as const) test(`shows exact ${scope} inheritance without changing assignments`, async ({ page }) => {
  const profile = saveProfile('可用本地模型')
  server.store.saveModelAssignment({ workspaceId, scope, scopeId: scope === 'workspace' ? workspaceId : scope === 'world' ? worldId : employeeId, modelProfileId: profile.id })
  await openChat(page)
  await expect(page.locator('.chat-model-readiness')).toContainText({ workspace: '继承全局', world: '继承世界', employee: '角色指定' }[scope])
  await expect(page.locator('.chat-model-readiness')).toContainText('可用本地模型')
  await page.getByRole('button', { name: '试试整理一份简报', exact: true }).click()
  await expect(page.locator('.composer textarea')).toHaveValue(/先给结论/)
  expect(chatRequests).toBe(0)
})

test('missing explicitly required key remains blocked and reachable from the same chat', async ({ page }) => {
  saveProfile('需要密钥的本地模型', true)
  await openChat(page)
  await expect(page.locator('.chat-model-readiness')).toContainText('当前模型还缺少密钥')
  await openSetup(page)
  await expect(page.getByRole('radio')).toBeVisible()
  await page.getByRole('button', { name: '返回对话', exact: true }).click()
  expect(chatRequests).toBe(0)
})

test('failed discovery retries one provider row and cancelled setup never assigns', async ({ page }) => {
  modelListFails = true
  expectedIssue = /Failed to load resource: the server responded with a status of (502|503|422)/
  await openChat(page); await openSetup(page); await fillProvider(page)
  const discover = page.getByRole('button', { name: '保存服务商并获取模型列表' })
  await discover.click()
  await expect(page.getByRole('alert')).toBeVisible()
  expect(server.store.listModelProviders(workspaceId)).toHaveLength(1)
  modelListFails = false
  await discover.click()
  await expect(page.getByRole('button', { name: '保存并导入模型池' })).toBeVisible()
  expect(server.store.listModelProviders(workspaceId)).toHaveLength(1)
  await page.getByRole('button', { name: '完成（服务商已保存，可稍后同步模型）', exact: true }).click()
  await page.getByRole('button', { name: '返回对话', exact: true }).click()
  expect(server.store.listModelAssignments(workspaceId)).toHaveLength(0)
  expect(server.store.listModelProfiles(workspaceId)).toHaveLength(0)
})

for (const interrupt of ['switch-owner', 'edit-draft'] as const) test(`delayed preflight never consumes newer input after ${interrupt} or duplicate clicks`, async ({ page }) => {
  saveProfile('可用本地模型')
  await openChat(page)
  await expect(page.locator('.chat-model-readiness')).toContainText('已配置')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let preflights = 0
  let sends = 0
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith(`/api/worlds/${worldId}/chat`)) sends++ })
  await page.route('**/model-readiness', async (route) => {
    preflights++
    await gate
    await route.continue()
  })
  await page.locator('.composer textarea').fill('第一次提交的草稿')
  const send = page.getByRole('button', { name: '发送', exact: true })
  await send.click(); await expect.poll(() => preflights).toBe(1)
  await send.click()
  if (interrupt === 'switch-owner') await selectChat(page, secondEmployeeName)
  await page.locator('.composer textarea').fill('更新后的独立草稿')
  const resumed = page.waitForResponse((response) => response.url().endsWith('/model-readiness') && response.status() === 200)
  release()
  await resumed
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('.composer textarea')).toHaveValue('更新后的独立草稿')
  if (interrupt === 'switch-owner') {
    await selectChat(page, employeeName)
    await expect(page.locator('.composer textarea')).toHaveValue('第一次提交的草稿')
  } else await expect(page.getByRole('alert')).toContainText('草稿已更新')
  expect(sends).toBe(0); expect(chatRequests).toBe(0)
})

test('model check outage keeps draft and allows an explicit retry after recovery', async ({ page }) => {
  saveProfile('可用本地模型')
  await openChat(page)
  await expect(page.locator('.chat-model-readiness')).toContainText('已配置')
  expectedIssue = /Failed to load resource: the server responded with a status of 503/
  await page.route('**/model-readiness', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'fixture_unavailable', message: '测试服务暂时不可用' } }) }))
  await page.locator('.composer textarea').fill('恢复后再发送这份草稿')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('测试服务暂时不可用')
  await expect(page.locator('.composer textarea')).toHaveValue('恢复后再发送这份草稿')
  expect(chatRequests).toBe(0)
  await page.unroute('**/model-readiness')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.message__content').filter({ hasText: fixtureReply })).toBeVisible({ timeout: 30_000 })
  expect(chatRequests).toBe(1)
})

test('keyboard focus stays in setup and returns to the visible chat on close at a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await openChat(page); await openSetup(page)
  const dialog = page.getByRole('dialog', { name: 'AI 模型管理中心', exact: true })
  await expect(page.getByRole('button', { name: '关闭模型中心', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('04-narrow-setup.png') })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.composer textarea')).toBeFocused()
})
