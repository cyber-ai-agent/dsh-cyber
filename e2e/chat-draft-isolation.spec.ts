import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer
let root = ''
let origin = ''
let worldId = ''
let firstName = ''
let worldName = ''
const secondName = '草稿审阅员'
const otherWorldName = '草稿隔离世界'
const otherEmployeeName = '另一世界角色'
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
let consoleLog: string[] = []

test.beforeEach(async ({ page }) => {
  consoleLog = []
  attachAppConsoleRecorder(page, consoleLog)
})

test.afterEach(async ({}, testInfo) => {
  await testInfo.attach('console', { body: Buffer.from(consoleLog.join('\n') || 'No console errors or warnings.'), contentType: 'text/plain' })
})

test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  root = await mkdtemp(join(tmpdir(), 'cyber-draft-e2e-'))
  server = await createCyberServer({
    stateRoot: root, workspacePath: root, port: 0,
    webRoot: join(process.cwd(), 'packages/web/dist'), bootstrapDefaultWorld: true,
    runtime: {
      async runTurn(request) {
        const text = '已收到你的消息。'
        request.onEvent?.({ kind: 'assistant.message', source: 'draft-e2e', sourceSessionId: request.conversationId, content: text, metadata: {} })
        request.onEvent?.({ kind: 'turn.completed', source: 'draft-e2e', sourceSessionId: request.conversationId, metadata: {} })
        return { agentSessionId: request.conversationId, finalResponse: text, eventCount: 2 }
      },
      async close() {},
    },
  })
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  worldId = world.id
  worldName = world.name
  firstName = server.store.listEmployees(world.id)[0]!.displayName
  server.store.recruitEmployee({ workspaceId: workspace.id, worldId, blueprintId: 'core.butler', blueprintVersion: 1, displayName: secondName })
  const other = server.store.createWorld({ workspaceId: workspace.id, name: otherWorldName, templateId: 'personal-world' })
  server.store.recruitEmployee({ workspaceId: workspace.id, worldId: other.id, blueprintId: 'core.butler', blueprintVersion: 1, displayName: otherEmployeeName })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog
})

async function selectConversation(page: Page, name: string) {
  const entry = page.getByRole('button', { name: `与${name}私聊`, exact: true })
  await expect(entry).toBeVisible()
  await expect(entry).toBeEnabled()
  await entry.click()
  const composer = page.locator('.composer textarea')
  await expect(composer).toHaveAttribute('placeholder', new RegExp(name))
  return composer
}

async function uploadFiles(page: Page, names: string[]) {
  const button = page.getByRole('button', { name: '添加附件', exact: true })
  await expect(button).toBeVisible()
  await expect(button).toBeEnabled()
  const chooserPromise = page.waitForEvent('filechooser')
  await button.click()
  const chooser = await chooserPromise
  await chooser.setFiles(names.map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`测试资料：${name}`) })))
}

test('keeps delayed uploads and saved drafts with their original conversation and world', async ({ page }, testInfo) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  let started!: () => void
  const uploadStarted = new Promise<void>((resolve) => { started = resolve })
  let release!: () => void
  const uploadReleased = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/api/worlds/${worldId}/assets/attachment`, async (route) => {
    if ((route.request().postDataJSON() as { name: string }).name !== 'owner-a.txt') {
      await route.continue()
      return
    }
    started()
    await uploadReleased
    await route.continue()
  })
  try {
    await page.goto(origin)
    await expect(page.locator('.workbench-shell')).toBeVisible()
    const composer = await selectConversation(page, firstName)
    await composer.fill('第一位角色的未发送草稿')
    await uploadFiles(page, ['owner-a.txt'])
    await uploadStarted
    await selectConversation(page, secondName)
    await expect(composer).toHaveValue('')
    await composer.fill('第二位角色的未发送草稿')
    await uploadFiles(page, ['owner-b.txt'])
    await expect(page.locator('.composer-attachments')).toContainText('owner-b.txt')
    const completed = page.waitForResponse((response) => response.url().endsWith(`/api/worlds/${worldId}/assets/attachment`))
    release()
    await completed
    await expect(page.locator('.composer')).not.toContainText('owner-a.txt')
    await selectConversation(page, firstName)
    await expect(composer).toHaveValue('第一位角色的未发送草稿')
    await expect(page.locator('.composer-attachments')).toContainText('owner-a.txt')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
    await expect(page.locator('.composer')).not.toContainText('owner-b.txt')
    await page.reload()
    await selectConversation(page, firstName)
    await expect(composer).toHaveValue('第一位角色的未发送草稿')
    await expect(page.locator('.composer-attachments')).toContainText('owner-a.txt')

    await page.locator('.topbar-world-switcher > summary').click()
    await page.getByRole('menuitemradio').filter({ hasText: otherWorldName }).click()
    await selectConversation(page, otherEmployeeName)
    await expect(composer).toHaveValue('')
    await expect(page.locator('.composer')).not.toContainText('owner-a.txt')
    await page.locator('.topbar-world-switcher > summary').click()
    await page.getByRole('menuitemradio').filter({ hasText: worldName }).click()
    await selectConversation(page, firstName)
    await expect(composer).toHaveValue('第一位角色的未发送草稿')
    await expect(page.locator('.composer-attachments')).toContainText('owner-a.txt')

    const screenshots = process.env.DSH_AUDIT_SCREENSHOT_DIR ?? join(tmpdir(), 'dsh-cyber-audit-drafts')
    await mkdir(screenshots, { recursive: true })
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
      await page.setViewportSize(viewport)
      const path = join(screenshots, `draft-${viewport.width}x${viewport.height}.png`)
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
      expect(await page.locator('.workbench-shell').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      const readable = await page.locator('.composer-attachments').evaluate((element) => {
        const color = (css: string) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 1
          const context = canvas.getContext('2d')!
          context.fillStyle = css
          context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((sum, value, index) => {
          const channel = value / 255
          return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
        }, 0)
        const text = [...element.querySelectorAll('strong, small')].map((node) => {
          const foreground = color(getComputedStyle(node).color)
          const background = color(getComputedStyle(node.closest('.composer-attachments > span')!).backgroundColor)
          const a = luminance(foreground)
          const b = luminance(background)
          return { fontSize: parseFloat(getComputedStyle(node).fontSize), contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), opaqueBackground: background[3] === 255 }
        })
        return { text, buttons: [...element.querySelectorAll('button')].map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })) }
      })
      for (const item of readable.text) {
        expect(item.fontSize).toBeGreaterThanOrEqual(12)
        expect(item.opaqueBackground).toBe(true)
        expect(item.contrast).toBeGreaterThanOrEqual(4.5)
      }
      for (const button of readable.buttons) {
        expect(button.width).toBeGreaterThanOrEqual(40)
        expect(button.height).toBeGreaterThanOrEqual(40)
      }
      await testInfo.attach(`readability-${viewport.width}`, { body: Buffer.from(JSON.stringify(readable, null, 2)), contentType: 'application/json' })
      await page.screenshot({ path })
      await testInfo.attach(`draft-${viewport.width}`, { path, contentType: 'image/png' })
    }
    expect(issues).toEqual([])
  } finally {
    release?.()
  }
})

test('retains each successful attachment when another upload fails', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/assets/attachment', async (route) => {
    const body = route.request().postDataJSON() as { name: string }
    if (body.name === 'failed.txt') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试附件上传失败' } }) })
    } else await route.continue()
  })
  await page.goto(origin)
  await selectConversation(page, firstName)
  await uploadFiles(page, ['ready.txt', 'failed.txt'])
  await expect(page.locator('.composer-attachments')).toContainText('ready.txt')
  await expect(page.locator('.composer')).toContainText('测试附件上传失败')
  await selectConversation(page, secondName)
  await expect(page.locator('.composer')).not.toContainText('ready.txt')
  await selectConversation(page, firstName)
  await expect(page.locator('.composer-attachments')).toContainText('ready.txt')
  expect(pageErrors).toEqual([])
})

test('clears only the draft and preserves the existing conversation', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.goto(origin)
  const composer = await selectConversation(page, firstName)
  await composer.fill('保留这条已发送消息')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('保留这条已发送消息', { exact: true }).first()).toBeVisible()
  await uploadFiles(page, ['clear-me.txt'])
  await expect(page.locator('.composer-attachments')).toContainText('clear-me.txt')
  await composer.fill('/清空草稿')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(composer).toHaveValue('')
  await expect(page.locator('.composer')).not.toContainText('clear-me.txt')
  await expect(page.getByText('保留这条已发送消息', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.composer-topic-notice')).toContainText('草稿')
  await expect(page.locator('.composer-topic-notice')).not.toContainText('已开启新话题')
  await expect(page.locator('.message__content').filter({ hasText: '/清空草稿' })).toHaveCount(0)
  await composer.fill('/换个话题')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.locator('.composer-topic-notice')).toContainText('草稿')
  await expect(page.locator('.composer-topic-notice')).not.toContainText('已开启新话题')
  await expect(page.locator('.message__content').filter({ hasText: '/换个话题' })).toHaveCount(0)
  expect(issues).toEqual([])
})
