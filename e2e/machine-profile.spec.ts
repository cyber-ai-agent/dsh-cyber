import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { auditVisuals } from './visual-audit-helpers.js'

/**
 * The machine profile is host state: it lives in world settings, never in the
 * sidebar, and the owner can probe it, add their own CLI names and remove
 * them again. Every control asserted here is a real visible button.
 */
let server: CyberServer
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-machine-profile-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('probes the host, edits custom CLI names, and stays inside the settings surface', async ({ page }, testInfo) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()

  // The profile belongs to settings, not to the conversation sidebar.
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await expect(dock.getByRole('button', { name: '机器档案' })).toHaveCount(0)

  await page.getByRole('button', { name: '世界管理' }).click()
  const settings = page.getByRole('dialog', { name: /世界管理|世界设置/ })
  await settings.getByRole('button', { name: '机器档案' }).click()

  const panel = settings.locator('.machine-profile')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('宿主探测的本机事实')
  // Nothing probed yet: the empty state still offers the one action that can fix it.
  await expect(panel).toContainText('还没有生成机器档案')

  const refresh = panel.getByRole('button', { name: '刷新档案' })
  await expect(refresh).toBeEnabled()
  await refresh.click()

  // A real probe of this machine: a system line and at least one installed tool.
  await expect(panel.locator('.machine-profile__summary code')).toContainText('shell:')
  await expect(panel.locator('.machine-profile__chip').first()).toBeVisible({ timeout: 20_000 })
  await expect(panel).toContainText('已安装')
  await expect(panel).toContainText('未安装')

  // Owner-declared CLI names: add one, see it, remove it.
  await panel.getByRole('textbox').fill('e2e-probe-tool')
  await panel.getByRole('button', { name: '添加' }).click()
  await expect(panel).toContainText('e2e-probe-tool')
  await expect(panel).toContainText('自定义')
  const remove = panel.getByRole('button', { name: '移除' })
  await expect(remove).toBeVisible()
  await remove.click()
  await expect(panel).not.toContainText('e2e-probe-tool')

  // The visual gate: three viewports, no clipping, no horizontal overflow,
  // plus the measurable half of the gate (font floor, no parent dimming,
  // WCAG AA contrast) asserted on the real rendered page.
  for (const [width, height] of [[1440, 900], [1920, 1080], [3840, 2160]] as const) {
    await page.setViewportSize({ width, height })
    await expect(panel).toBeVisible()
    const box = await panel.boundingBox()
    expect(box, `${width}x${height} bounding box`).not.toBeNull()
    expect(box!.x, `${width}x${height} left edge`).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, `${width}x${height} right edge`).toBeLessThanOrEqual(width + 1)
    expect(box!.y + box!.height, `${width}x${height} bottom edge`).toBeLessThanOrEqual(height + 1)
    const audit = await auditVisuals(panel)
    expect(audit.overflow, `${width}x${height} horizontal overflow`).toBeLessThanOrEqual(1)
    expect(audit.minFontSize, `${width}x${height} smallest font`).toBeGreaterThanOrEqual(12)
    expect(audit.minOpacity, `${width}x${height} parent dimming`).toBeGreaterThanOrEqual(0.99)
    expect(audit.minContrast, `${width}x${height} contrast`).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: testInfo.outputPath(`machine-profile-${width}x${height}.png`) })
  }

  // Closing without saving must not disturb host state.
  await settings.getByRole('button', { name: '取消' }).click()
  await expect(settings).toBeHidden()
  const stored = JSON.parse(await readFile(join(stateRoot, 'environments', 'local.json'), 'utf8')) as {
    tools: Record<string, { present: boolean; source: string }>
  }
  expect(Object.keys(stored.tools).length).toBeGreaterThan(0)
  expect(Object.values(stored.tools).some((tool) => tool.present)).toBe(true)
  expect(issues, issues.join('\n')).toEqual([])
})
