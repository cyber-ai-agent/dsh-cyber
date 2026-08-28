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
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-i18n-e2e-'))
  await startServer()
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('persists one selected interface language across reload and service restart, including RTL', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  const screenshotRoot = join(process.cwd(), 'artifacts', 'i18n-locale')
  await mkdir(screenshotRoot, { recursive: true })
  await page.goto(origin)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('界面语言').selectOption('en-US')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await page.getByRole('button', { name: 'Save appearance' }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.locale-setting select')).toHaveValue('en-US')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.getByText('Appearance and layout', { exact: true }).first()).toBeVisible()
  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await page.locator('.settings-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `english-settings-${viewport.label}.png`) })
  }
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Creative workshop', exact: true }).click()
  const englishWorkshop = page.getByRole('dialog', { name: 'Creative workshop' })
  await expect(englishWorkshop).toBeVisible()
  await expect(englishWorkshop.getByText('Build Your Custom Cyber Agent World', { exact: true })).toBeVisible()
  await expect(englishWorkshop.getByText('Quick Start from Templates', { exact: true })).toBeVisible()
  expect(await englishWorkshop.textContent()).not.toMatch(/创意工坊|我的世界|赛博公司|角色酒馆|自媒体工作室|远星观测站/)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(screenshotRoot, 'english-workshop-1440x900.png') })
  await englishWorkshop.getByRole('button', { name: 'Close creative workshop' }).click()
  await openTasks(page)
  await expect(page.getByRole('region', { name: 'Task workspace' })).toBeVisible()
  await expect(page.getByText(/completed|superseded|accepted|request-changes/, { exact: true })).toHaveCount(0)

  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `english-${viewport.label}.png`) })
  }

  await server?.close()
  server = undefined
  await startServer()
  await page.goto(origin)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Interface language').selectOption('ar-SA')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar-SA')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  expect(await page.locator('.settings-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true)
  await page.locator('.settings-dialog__footer .primary-button').click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar-SA')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await page.getByRole('button', { name: 'الورشة الإبداعية', exact: true }).click()
  const arabicWorkshop = page.getByRole('dialog', { name: 'الورشة الإبداعية' })
  await expect(arabicWorkshop.getByText('أنشئ عالمك المخصص من وكلاء السايبر', { exact: true })).toBeVisible()
  expect(await arabicWorkshop.textContent()).not.toMatch(/创意工坊|我的世界|赛博公司|角色酒馆|自媒体工作室|远星观测站/)
  await arabicWorkshop.getByRole('button', { name: 'إغلاق الورشة الإبداعية' }).click()

  // Existing workspaces may have a browser bootstrap locale that differs from
  // the saved preference. Switching back must update every mounted surface,
  // persist, and survive another reload instead of leaving English shell copy
  // around a Chinese selector.
  await page.locator('.topbar nav button').last().click()
  await page.locator('.locale-setting select').selectOption('zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  await expect(page.getByText('外观与布局', { exact: true }).first()).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(screenshotRoot, 'chinese-settings-1440x900.png') })
  await page.locator('.settings-dialog__footer .primary-button').click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
  expect(issues, issues.join('\n')).toEqual([])
})

async function startServer(): Promise<void> {
  server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
  })
  origin = (await server.start()).origin
}

async function openTasks(page: import('@playwright/test').Page): Promise<void> {
  const taskTab = page.getByRole('tab', { name: 'Tasks' })
  if (await taskTab.count() === 0) {
    await page.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitemcheckbox', { name: 'Tasks' }).click()
  } else {
    await taskTab.click()
  }
}
