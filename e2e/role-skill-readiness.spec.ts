import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { EmployeeInstance, SkillCatalogEntry, World } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'

let server: CyberServer
let origin: string
let stateRoot: string
let world: World
let otherWorld: World
let employee: EmployeeInstance
let otherRole: EmployeeInstance
let skill: SkillCatalogEntry
let installedSkill: SkillCatalogEntry
const previousCatalogUrl = process.env.DSH_CYBER_MODEL_CATALOG_URL
const screenshots = process.env.CYBER_QA_SCREENSHOTS

test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-skill-readiness-'))
  server = await createCyberServer({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, bootstrapDefaultWorld: true })
  origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  world = server.store.listWorlds(workspace.id)[0]!
  employee = server.store.listEmployees(world.id)[0]!
  otherWorld = (await request<{ world: World }>(`/api/workspaces/${workspace.id}/worlds`, { name: '隔离世界', templateId: 'personal-world' })).world
  otherRole = (await request<{ employee: EmployeeInstance }>(`/api/worlds/${world.id}/recruit`, { blueprintId: employee.blueprintId, blueprintVersion: employee.blueprintVersion, displayName: '未授权助手', skillGrants: [] })).employee
  const market = await request<{ items: Array<{ manifest: { id: string; version: string } }> }>('/api/marketplace?market=plugin')
  const plugin = market.items.find((item) => item.manifest.id === 'official-firecrawl-search')!
  const preview = await request<{ preview: { approvalToken: string } }>(`/api/workspaces/${workspace.id}/marketplace/preview`, { packageId: plugin.manifest.id, version: plugin.manifest.version })
  await request(`/api/workspaces/${workspace.id}/marketplace/install`, { packageId: plugin.manifest.id, version: plugin.manifest.version, approvalToken: preview.preview.approvalToken, worldId: world.id })
  const catalog = await request<{ items: SkillCatalogEntry[] }>(`/api/worlds/${world.id}/skill-catalog`)
  skill = catalog.items.find((item) => item.id === 'coding')!
  installedSkill = catalog.items.find((item) => item.id === 'web.search.firecrawl')!
  expect(skill.worldAvailable).toBe(true)
  expect(installedSkill.worldAvailable).toBe(true)
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
  if (previousCatalogUrl === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalogUrl
})

test('explains fresh role skills and repairs world availability through explicit scoped settings', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  expect(await page.title()).toContain('DSH Cyber')
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.fill('保留这个技能配置期间的草稿')
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await dock.getByRole('button', { name: `查看角色 ${employee.displayName}`, exact: true }).click()
  await dock.getByRole('button', { name: '技能', exact: true }).click()
  const panel = page.getByRole('region', { name: `${employee.displayName}的技能可用性` })
  await expect(panel).toContainText('尚未授权角色技能')
  await expect(panel).toContainText('角色未授权')
  expect(grants(employee.id)).toEqual([])
  await shot(page, 'role-skills-empty-light')
  for (const scheme of ['dark', 'light'] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.colorScheme = value; document.documentElement.dataset.resolvedColorScheme = value }, scheme)
    await expect.poll(() => controlContrast(panel.locator('.primary-button')), { message: `empty-state CTA contrast in ${scheme}` }).toBeGreaterThanOrEqual(4.5)
  }
  await panel.getByRole('button', { name: '管理角色技能', exact: true }).click()
  const management = page.getByRole('dialog', { name: `角色设置 · ${employee.displayName}` })
  await expect(management.getByRole('tab', { name: '技能', exact: true })).toHaveAttribute('aria-selected', 'true')
  const skillCheckbox = management.locator('.skill-grant-row').filter({ hasText: skill.displayName }).getByRole('checkbox')
  await expect(skillCheckbox).not.toBeChecked()
  await skillCheckbox.check()
  await management.getByRole('button', { name: '关闭角色设置' }).click()
  expect(grants(employee.id)).toEqual([])
  await panel.getByRole('button', { name: '管理角色技能', exact: true }).click()
  await expect(skillCheckbox).not.toBeChecked()
  await skillCheckbox.check()
  await management.locator('.skill-grant-row').filter({ hasText: installedSkill.displayName }).getByRole('checkbox').check()
  await management.getByRole('button', { name: '保存角色技能' }).click()
  await expect(management).toBeHidden()
  await expect(panel).toContainText('2 项可使用')
  await expect(panel).toContainText('成长与验证记录 · 0')
  expect(grants(employee.id)).toEqual(expect.arrayContaining([skill.id, installedSkill.id]))
  expect(grants(otherRole.id)).toEqual([])
  await expect(composer).toHaveValue('保留这个技能配置期间的草稿')

  await panel.getByRole('button', { name: '世界技能设置', exact: true }).click()
  const center = page.getByRole('dialog', { name: '技能中心', exact: true })
  await expect(center.locator('.skill-center__settings-header h3')).toHaveText(world.name)
  await expect(center.locator('.skill-center__scope-rail .is-active')).toContainText(world.name)
  const settingsBefore = await request(`/api/workspaces/${world.workspaceId}/skill-settings`)
  const packageCheckbox = center.locator('.skill-center__check-list > label').filter({ hasText: installedSkill.displayName }).getByRole('checkbox')
  await packageCheckbox.uncheck()
  await center.getByRole('button', { name: '关闭技能中心' }).click()
  expect(await request(`/api/workspaces/${world.workspaceId}/skill-settings`)).toEqual(settingsBefore)
  await panel.getByRole('button', { name: '世界技能设置', exact: true }).click()
  await expect(packageCheckbox).toBeChecked()
  await packageCheckbox.uncheck()
  await center.getByRole('button', { name: '保存技能设置', exact: true }).click()
  await expect(center.getByRole('button', { name: '保存技能设置', exact: true })).toBeDisabled()
  await center.getByRole('button', { name: '关闭技能中心' }).click()
  const blockedRow = panel.locator('.role-skills__row').filter({ hasText: installedSkill.displayName })
  await expect(blockedRow).toContainText('世界未启用')
  await expect(panel).toContainText('1 项可使用')
  expect(grants(employee.id)).toContain(installedSkill.id)
  expect(server.store.listWorldSkillActions(world.id)).toEqual([])
  const settingsAfter = await request<{ global: unknown; worlds: Array<{ scopeId: string }> }>(`/api/workspaces/${world.workspaceId}/skill-settings`)
  expect(settingsAfter.global).toEqual((settingsBefore as typeof settingsAfter).global)
  expect(settingsAfter.worlds.find((scope) => scope.scopeId === otherWorld.id)).toEqual((settingsBefore as typeof settingsAfter).worlds.find((scope) => scope.scopeId === otherWorld.id))
  await shot(page, 'role-skills-blocked-light')

  await blockedRow.getByRole('button', { name: '世界技能设置', exact: true }).click()
  await expect(center.locator('.skill-center__settings-header h3')).toHaveText(world.name)
  await packageCheckbox.check()
  await center.getByRole('button', { name: '保存技能设置', exact: true }).click()
  await expect(center.getByRole('button', { name: '保存技能设置', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(center).toBeHidden()
  await expect(panel).toContainText('2 项可使用')
  await expect(composer).toHaveValue('保留这个技能配置期间的草稿')

  for (const theme of ['dark', 'light'] as const) {
    // Isolated fixture preference; this changes no user settings or grants.
    await page.evaluate((scheme) => { document.documentElement.dataset.colorScheme = scheme; document.documentElement.dataset.resolvedColorScheme = scheme }, theme)
    await page.setViewportSize({ width: theme === 'dark' ? 1440 : 1024, height: 900 })
    await expect(panel).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-resolved-color-scheme', theme)
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await panel.evaluate((element) => Array.from(element.querySelectorAll('button, p, span, strong, summary')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12))).toBe(true)
    await shot(page, `role-skills-usable-${theme === 'dark' ? 'dark' : 'narrow'}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await dock.getByRole('button', { name: '全部角色', exact: true }).click()
  await dock.getByRole('button', { name: `查看角色 ${otherRole.displayName}`, exact: true }).click()
  await dock.getByRole('button', { name: '技能', exact: true }).click()
  const otherPanel = page.getByRole('region', { name: `${otherRole.displayName}的技能可用性` })
  await expect(otherPanel).toContainText('尚未授权角色技能')
  await expect(otherPanel).not.toContainText('2 项可使用')

  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => { release = resolve })
  let intercepted = false
  await page.route(`**/api/worlds/${world.id}/skill-catalog`, async (route) => { intercepted = true; await held; await route.continue() })
  await otherPanel.getByRole('button', { name: '刷新角色技能' }).click()
  await expect.poll(() => intercepted).toBe(true)
  await page.getByLabel(`切换世界：${world.name}`, { exact: true }).click()
  await page.getByRole('menuitemradio').filter({ hasText: otherWorld.name }).click()
  release!()
  await openDockTab(dock, '角色')
  const otherWorldRole = server.store.listEmployees(otherWorld.id)[0]!
  await dock.getByRole('button', { name: `查看角色 ${otherWorldRole.displayName}`, exact: true }).click()
  await dock.getByRole('button', { name: '技能', exact: true }).click()
  await expect(page.locator('.role-skills')).toContainText(`${otherWorld.name} · ${otherWorldRole.displayName}`)
  await expect(page.locator('.role-skills')).toContainText('尚未授权角色技能')
  await expect(page.locator('.role-skills')).not.toContainText('2 项可使用')
  expect(grants(otherWorldRole.id)).toEqual([])
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

function grants(employeeId: string): string[] { const employee = server.store.getEmployee(employeeId)!; return server.store.getEmployeeRevision(employee.id, employee.currentRevision)!.skillGrants }
async function request<T = unknown>(path: string, body?: unknown): Promise<T> { const response = await fetch(`${origin}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); expect(response.ok, JSON.stringify(result)).toBe(true); return result as T }
async function shot(page: import('@playwright/test').Page, name: string) { if (screenshots === undefined) return; await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: false }) }

async function controlContrast(locator: import('@playwright/test').Locator): Promise<number> {
  return locator.evaluate((element) => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.fillStyle = 'white'; context.fillRect(0, 0, 1, 1)
    const ancestors: Element[] = []
    for (let current: Element | null = element; current !== null; current = current.parentElement) ancestors.unshift(current)
    for (const ancestor of ancestors) { context.fillStyle = getComputedStyle(ancestor).backgroundColor; context.fillRect(0, 0, 1, 1) }
    const background = context.getImageData(0, 0, 1, 1).data
    context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
    const foreground = context.getImageData(0, 0, 1, 1).data
    const luminance = (rgba: Uint8ClampedArray) => { const c = Array.from(rgba).slice(0, 3).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]! }
    const a = luminance(background); const b = luminance(foreground)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })
}
