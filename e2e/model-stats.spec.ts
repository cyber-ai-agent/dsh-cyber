import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
let server: CyberServer
let stateRoot = ''; let origin = ''; let workspaceId = ''; let providerId = ''
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL

test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'cyber-model-stats-browser-'))
  server = await createCyberServer({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, bootstrapDefaultWorld: true })
  workspaceId = server.store.listWorkspaces()[0]!.id
  providerId = server.store.saveModelProvider({ workspaceId, kind: 'custom', name: '统计测试服务商', baseUrl: 'https://stats.example/v1', providerKind: 'openai-compatible-remote', api: 'openai-completions' }).id
  for (const [days, tokens, cached] of [[0, 100, 20], [20, 200, 0], [60, 300, undefined]] as const) {
    const row = server.store.recordModelInteraction({ workspaceId, providerId, providerName: '统计测试服务商', source: 'turn', provider: '模型昵称而非服务商名称', modelId: 'shared-model', status: 'success', promptMessageCount: 1, promptCharCount: 5, tokensPrompt: tokens, tokensCompletion: 10, ...(cached === undefined ? {} : { tokensCached: cached }), toolCallCount: 3, durationMs: 100 })
    server.store.database.prepare('UPDATE model_interaction_logs SET created_at=? WHERE id=?').run(new Date(Date.now() - days * 86_400_000).toISOString(), row.id)
  }
  server.store.saveModelProvider({ workspaceId, kind: 'custom', name: '无交互服务商', baseUrl: 'https://empty.example/v1', providerKind: 'openai-compatible-remote', api: 'openai-completions' })
  for (const source of [{ provider: '仅日志昵称' }, { provider: '旧模型', providerId: 'removed-provider', providerName: '已删除服务商' }]) {
    server.store.recordModelInteraction({ workspaceId, ...source, source: 'turn', modelId: 'legacy-model', status: 'success', promptMessageCount: 1, promptCharCount: 0, durationMs: 1 })
  }
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }); if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL; else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog })

test('filters stats on one click, refreshes actual logs, and fits desktop and small screens', async ({ page }, info) => {
  const consoleIssues: string[] = []; attachAppConsoleRecorder(page, consoleIssues)
  const requests: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/workspaces/${workspaceId}/model-stats`) requests.push(url)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin); await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' }); await settings.getByRole('button', { name: /AI 模型/ }).click()
  await settings.getByRole('button', { name: '打开模型中心', exact: true }).click()
  const hub = page.getByRole('dialog', { name: 'AI 模型管理中心' }); await hub.getByRole('button', { name: '模型统计', exact: true }).click()
  const value = hub.locator('.model-hub__stat-card strong').first()
  await expect(value).toHaveText('100'); expect(requests).toHaveLength(1)
  const sidebar = hub.locator('.model-hub__stats-sidebar')
  await expect(sidebar.getByRole('button')).toHaveCount(3)
  await expect(sidebar).not.toContainText('仅日志昵称')
  await expect(sidebar).not.toContainText('已删除服务商')
  await expect(sidebar.getByRole('button', { name: '无交互服务商', exact: true })).toBeVisible()
  await hub.getByRole('button', { name: '近 30 天', exact: true }).click(); await expect(value).toHaveText('300'); expect(requests).toHaveLength(2)
  expect(Date.parse(requests[1]!.searchParams.get('to')!) - Date.parse(requests[1]!.searchParams.get('from')!)).toBe(30 * 86_400_000)
  await expect(hub.getByRole('button', { name: '近 30 天', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await hub.locator('.model-hub__stats-time').getByRole('button', { name: '全部', exact: true }).click(); await expect(value).toHaveText('600')
  await hub.locator('.model-hub__stats-sidebar').getByRole('button', { name: '统计测试服务商', exact: true }).click()
  await expect(hub.locator('tbody tr')).toHaveCount(1); await expect(hub.locator('tbody tr').first()).toContainText('shared-model')
  expect(requests.at(-1)?.searchParams.get('providerId')).toBe(`provider:${providerId}`)
  await expect(hub.locator('.model-hub__stat-card strong').nth(4)).toHaveText('9')
  await expect(hub.locator('.model-hub__stat-card strong').nth(2)).toHaveText('20')
  server.store.recordModelInteraction({ workspaceId, providerId, providerName: '统计测试服务商', source: 'turn', provider: '模型昵称而非服务商名称', modelId: 'shared-model', status: 'success', promptMessageCount: 1, promptCharCount: 5, tokensPrompt: 5, durationMs: 100, toolCallCount: 1 })
  await hub.getByRole('button', { name: '刷新统计', exact: true }).click(); await expect(value).toHaveText('605')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await expect(hub.locator('.model-hub__stats-main')).toBeVisible()
    const bounds = await hub.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height)
    expect(await hub.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false)
    expect(await hub.locator('tbody tr').first().locator('td').last().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap')
    await page.screenshot({ path: info.outputPath(`model-stats-${size.width}x${size.height}.png`) })
  }
  await sidebar.getByRole('button', { name: '无交互服务商', exact: true }).click()
  await expect(hub.locator('tbody tr')).toHaveCount(0)
  await expect(value).toHaveText('0')
  await sidebar.getByRole('button', { name: '全部', exact: true }).click()
  await expect(value).toHaveText('605')
  await writeFile(info.outputPath('console.json'), JSON.stringify(consoleIssues, null, 2)); expect(consoleIssues).toEqual([])
})
