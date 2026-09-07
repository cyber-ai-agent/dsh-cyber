import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
let server: CyberServer; let root: string; let origin: string; let workspaceId: string; let providerId: string
const previousCatalogUrl = process.env.DSH_CYBER_MODEL_CATALOG_URL
test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  root = await mkdtemp(join(tmpdir(), 'cyber-model-stats-browser-'))
  server = await createCyberServer({ stateRoot: root, workspacePath: root, webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, bootstrapDefaultWorld: true })
  workspaceId = server.store.listWorkspaces()[0]!.id
  const provider = server.store.saveModelProvider({ workspaceId, name: '统计测试服务商', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', providerKind: 'openai-compatible-local' }); providerId = provider.id
  for (const [days, input, cache] of [[0, 100, 20], [20, 200, 0], [60, 300, undefined]] as const) {
    const row = server.store.recordModelInteraction({ workspaceId, providerId, providerName: provider.name, modelId: 'shared-model', provider: '模型昵称而非服务商名称', source: 'turn', status: 'success', promptMessageCount: 1, promptCharCount: 3, durationMs: 120, toolCallCount: 3, tokensPrompt: input, tokensCompletion: 10, ...(cache === undefined ? {} : { tokensCached: cache }) })
    server.store.database.prepare('UPDATE model_interaction_logs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - days * 86_400_000).toISOString(), row.id)
  }
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server.close(); await rm(root, { recursive: true, force: true }); if (previousCatalogUrl === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL; else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalogUrl })

test('model stats changes range/provider with one click, refreshes, and fits desktop/mobile', async ({ page }, info) => {
  const issues: string[] = []; attachAppConsoleRecorder(page, issues)
  const queries: URL[] = []; page.on('request', (r) => { if (r.url().includes('/model-stats')) queries.push(new URL(r.url())) })
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: /AI 模型/ }).click(); await settings.getByRole('button', { name: '打开模型中心', exact: true }).click()
  const hub = page.getByRole('dialog', { name: 'AI 模型管理中心', exact: true })
  await hub.getByRole('button', { name: '模型统计', exact: true }).click()
  const totals = hub.locator('.model-hub__stat-card strong')
  await expect(totals.nth(0)).toHaveText('100'); expect(queries).toHaveLength(1)
  await hub.getByRole('button', { name: '近 30 天', exact: true }).click(); await expect(totals.nth(0)).toHaveText('300')
  expect(queries).toHaveLength(2); expect(Date.parse(queries[1]!.searchParams.get('to')!) - Date.parse(queries[1]!.searchParams.get('from')!)).toBe(30 * 86_400_000)
  await expect(hub.locator('.model-hub__stats-time .is-active')).toHaveText('近 30 天')
  await hub.locator('.model-hub__stats-time').getByRole('button', { name: '全部', exact: true }).click(); await expect(totals.nth(0)).toHaveText('600')
  await hub.getByRole('button', { name: '统计测试服务商', exact: true }).click(); await expect(hub.locator('.model-hub__stats-table tbody')).toContainText('shared-model')
  expect(queries.at(-1)!.searchParams.get('providerId')).toBe(`provider:${providerId}`)
  await expect(totals.nth(4)).toHaveText('9'); await expect(totals.nth(2)).toHaveText('20')
  server.store.recordModelInteraction({ workspaceId, providerId, providerName: '统计测试服务商', modelId: 'shared-model', provider: '模型昵称', source: 'turn', status: 'success', promptMessageCount: 1, promptCharCount: 1, durationMs: 40, toolCallCount: 1, tokensPrompt: 5 })
  await hub.locator('.model-hub__stats').getByRole('button', { name: '刷新统计', exact: true }).click(); await expect(totals.nth(0)).toHaveText('605')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size)
    await expect(hub.locator('.model-hub__stats-main')).toBeVisible()
    const overflow = await hub.evaluate((e) => e.scrollWidth > e.clientWidth + 1); expect(overflow).toBe(false)
    await page.screenshot({ path: info.outputPath(`model-stats-${size.width}x${size.height}.png`) })
  }
  await writeFile(info.outputPath('console.json'), JSON.stringify(issues, null, 2)); expect(issues).toEqual([])
})
