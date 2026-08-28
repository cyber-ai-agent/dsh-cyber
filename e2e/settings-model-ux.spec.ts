import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-settings-model-ux-'))
  server = await createCyberServer({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages', 'web', 'dist'), port: 0, bootstrapDefaultWorld: true })
  const workspaceId = server.store.listWorkspaces()[0]!.id
  for (const [displayName, modelId, port, isDefault] of [
    ['本地推理模型', 'qwen3:14b', 11434, true],
    ['视觉模型', 'qwen2.5-vl:7b', 11435, false],
    ['代码模型', 'deepseek-coder:6.7b', 11436, false],
  ] as const) {
    server.store.saveModelProfile({ workspaceId, displayName, providerKind: 'openai-compatible-local', baseUrl: `http://127.0.0.1:${port}/v1`, modelId, api: 'openai-completions', isDefault, settings: { providerId: 'ollama', providerName: 'Ollama', contextWindow: 32_000 } })
  }
  origin = (await server.start()).origin
})

test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }) })

test('keeps model setup single-column, localized and responsive', async ({ page }) => {
  const consoleIssues: string[] = []
  const responseFailures: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  page.on('response', (response) => { if (response.status() >= 400) responseFailures.push(`${response.status()} ${response.url()}`) })
  const screenshotRoot = join(process.cwd(), 'artifacts', 'settings-model-ux')
  await mkdir(screenshotRoot, { recursive: true })

  await page.goto(origin)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: /AI 模型/ }).click()
  await expect(dialog.locator('.settings-nav')).toBeVisible()
  await expect(dialog.locator('.model-card-item')).toHaveCount(3)
  await expect(dialog.locator('.model-editor-panel')).toHaveCount(0)
  await expect(dialog.locator('.model-provider-pills')).toHaveCount(0)

  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    const layout = await dialog.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth + 1)
    await page.screenshot({ path: join(screenshotRoot, `model-list-${viewport.label}.png`) })
  }

  await page.setViewportSize({ width: 720, height: 900 })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await expect(dialog.locator('.settings-nav')).toBeVisible()
  await page.screenshot({ path: join(screenshotRoot, 'model-list-720x900.png') })

  await page.setViewportSize({ width: 1440, height: 900 })
  await dialog.locator('.model-card-item__select').first().click()
  const editor = dialog.locator('.model-editor-panel')
  await expect(editor).toBeVisible()
  await expect(dialog.locator('.model-list')).toBeHidden()
  await expect(editor.getByLabel('模型服务商')).toBeVisible()
  await expect(editor.getByLabel(/服务接口地址/)).toBeVisible()
  await expect(editor.getByRole('button', { name: '测试连接并获取模型' })).toBeVisible()
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: join(screenshotRoot, 'model-editor-1440x900.png') })

  await dialog.getByRole('button', { name: '外观与布局' }).click()
  await dialog.getByLabel('界面语言').selectOption('en-US')
  const englishDialog = page.getByRole('dialog', { name: 'Settings' })
  await englishDialog.getByRole('button', { name: /AI models/i }).click()
  const englishSection = englishDialog.locator('.settings-section--models')
  await expect(englishSection.getByText('Connected models', { exact: true })).toBeVisible()
  await expect(englishSection.getByRole('button', { name: 'Add service' })).toBeVisible()
  expect(await englishSection.textContent()).not.toMatch(/已连接模型|添加服务|模型使用范围|设置为默认/)
  await page.screenshot({ path: join(screenshotRoot, 'model-list-en-1440x900.png') })

  await englishDialog.locator('.settings-nav button').first().click()
  await englishDialog.getByLabel('Interface language').selectOption('ar-SA')
  const arabicDialog = page.locator('.settings-dialog')
  await arabicDialog.locator('.settings-nav button').nth(1).click()
  await expect(arabicDialog.getByText('النماذج المتصلة', { exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  expect(await arabicDialog.locator('.settings-section--models').textContent()).not.toMatch(/已连接模型|添加服务|模型使用范围|设置为默认/)
  await page.screenshot({ path: join(screenshotRoot, 'model-list-ar-1440x900.png') })
  expect(consoleIssues, [...consoleIssues, ...responseFailures].join('\n')).toEqual([])
})
