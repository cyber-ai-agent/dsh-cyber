import { openGlobalTool } from './global-tool-helpers.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest, SkillCatalogEntry, SkillSettingsView } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-skill-center-entity-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: new QuietRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('shows one row per MCP service and Skill package, with import controls and visual evidence', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  const current = server!
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const catalog = syntheticCatalog()
  const settings = syntheticSettings(workspace.id, world.id, catalog.map((item) => item.id))
  await page.route(`**/api/workspaces/${workspace.id}/skill-catalog`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: catalog }) }))
  await page.route(`**/api/workspaces/${workspace.id}/skill-settings`, async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(settings) }))
  await page.route(`**/api/workspaces/${workspace.id}/skills/*/detail`, async (route) => {
    const entry = catalog.find((item) => decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '') === item.id) ?? catalog[0]!
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      entry,
      tree: entry.packageId === 'official-browser' ? entryFiles().map((path) => ({ path, kind: 'file' })) : [{ path: 'descriptor.json', kind: 'file' }],
      files: entry.packageId === 'official-browser' ? entryFiles().map((path) => ({ path, language: path.endsWith('.json') ? 'json' : 'markdown', content: path.endsWith('.json') ? '{}' : '# Skill', editable: false })) : [{ path: 'descriptor.json', language: 'json', content: JSON.stringify(entry), editable: false }],
      editable: false,
      ...(entry.packageId === undefined ? {} : { packageId: entry.packageId, packageVersion: entry.packageVersion }),
    })
  })
  })

  await page.goto(origin)
  await openGlobalTool(page, '技能中心')
  const center = page.getByRole('dialog', { name: '技能中心' })
  await expect(center).toBeVisible()
  await expect(center.locator('.skill-center__skill-rows > button')).toHaveCount(3)
  await expect(center.locator('.skill-center__skill-rows > button').filter({ hasText: 'MCP · Playwright MCP' })).toHaveCount(1)
  await expect(center.locator('.skill-center__skill-rows > button').filter({ hasText: '只读网页浏览' })).toHaveCount(1)
  await expect(center.locator('.skill-center__entity-members')).toContainText('browser_click')
  await expect(center.locator('.skill-center__entity-members')).toContainText('browser_navigate')

  await center.getByRole('button', { name: '添加技能' }).click()
  await expect(center).toContainText('选择 ZIP 技能包')
  await expect(center).toContainText('选择技能包文件夹')
  await expect(center).toContainText('目录由宿主固定管理')
  await expect(center).not.toContainText('本机软件包目录')
  await center.getByRole('button', { name: '技能列表' }).click()
  await expect(center.locator('.skill-center__skill-rows > button')).toHaveCount(3)

  const evidenceRoot = join(process.cwd(), 'artifacts', 'skill-center-entity-aggregation')
  await mkdir(evidenceRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(center).toBeVisible()
    const metrics = await center.evaluate((element) => ({
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      readableText: Array.from(element.querySelectorAll('button, input, label, small, em, p')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12),
      visibleEntityRows: element.querySelectorAll('.skill-center__skill-rows > button').length,
    }))
    expect(metrics).toEqual({ noHorizontalOverflow: true, readableText: true, visibleEntityRows: 3 })
    await page.screenshot({ path: join(evidenceRoot, `skill-center-${viewport.label}.png`), fullPage: false })
  }
  await center.getByRole('button', { name: '添加技能' }).click()
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const metrics = await center.evaluate((element) => ({
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      readableText: Array.from(element.querySelectorAll('button, input, label, small, em, p')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12),
    }))
    expect(metrics).toEqual({ noHorizontalOverflow: true, readableText: true })
    await page.screenshot({ path: join(evidenceRoot, `skill-center-import-${viewport.label}.png`), fullPage: false })
  }
  await writeFile(join(evidenceRoot, 'console.log'), issues.length === 0 ? 'No console errors or warnings.\n' : `${issues.join('\n')}\n`, 'utf8')
  expect(issues, issues.join('\n')).toEqual([])
})

function syntheticCatalog(): SkillCatalogEntry[] {
  return [
    catalogEntry('mcp.playwright.browser_click', '点击网页', { source: 'mcp', mcpService: { id: 'playwright', label: 'Playwright MCP' }, adapterId: 'builtin.mcp', kind: 'integration', dependencies: [{ kind: 'integration', id: 'builtin.mcp', required: true }] }),
    catalogEntry('mcp.playwright.browser_navigate', '打开网页', { source: 'mcp', mcpService: { id: 'playwright', label: 'Playwright MCP' }, adapterId: 'builtin.mcp', kind: 'integration', dependencies: [{ kind: 'integration', id: 'builtin.mcp', required: true }] }),
    catalogEntry('browser.open', '浏览器打开网页', { source: 'plugin', packageId: 'official-browser', packageVersion: '1.0.1', skillPackage: { id: 'official-browser', version: '1.0.1', displayName: '只读网页浏览', summary: '只读网页能力包。' } }),
    catalogEntry('browser.read', '浏览器读取网页', { source: 'plugin', packageId: 'official-browser', packageVersion: '1.0.1', skillPackage: { id: 'official-browser', version: '1.0.1', displayName: '只读网页浏览', summary: '只读网页能力包。' } }),
    catalogEntry('core.notes', '记录整理', { source: 'builtin', kind: 'recipe' }),
  ]
}

function catalogEntry(id: string, displayName: string, overrides: Partial<SkillCatalogEntry>): SkillCatalogEntry {
  return {
    id,
    displayName,
    summary: `${displayName}说明`,
    adapterId: 'builtin.recipe',
    risks: [],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'recipe',
    recommendedByDefault: true,
    source: 'builtin',
    scope: 'workspace',
    globalKnown: true,
    worldAvailable: true,
    availability: 'available',
    ...overrides,
  }
}

function syntheticSettings(workspaceId: string, worldId: string, skillIds: string[]): SkillSettingsView {
  const scope = (scopeId: string, displayName: string, scope: 'workspace' | 'world') => ({ scope, scopeId, displayName, configured: true, inherited: false, skillIds })
  return { global: scope(workspaceId, '全局', 'workspace'), worlds: [scope(worldId, '我的世界', 'world')] }
}

function entryFiles(): string[] { return ['skill-open.json', 'skill-read.json', 'skill-extract.json', 'skill-screenshot.json'] }

class QuietRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) { return { agentSessionId: request.agent.agentSessionId ?? 'quiet', finalResponse: '完成', eventCount: 0 } }
  async close() {}
}
