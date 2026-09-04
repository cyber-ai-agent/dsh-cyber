import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
const previousCatalogUrl = process.env.DSH_CYBER_MODEL_CATALOG_URL

test.beforeAll(async () => {
  // Keep this browser contract deterministic and offline: the hub still
  // exercises the bundled catalog and signup guidance fallback.
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-model-hub-ux-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
  })
  const workspaceId = server.store.listWorkspaces()[0]!.id
  const provider = server.store.saveModelProvider({
    workspaceId,
    kind: 'local',
    catalogRef: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai-completions',
    providerKind: 'openai-compatible-local',
  })
  const models = [
    ['本地推理模型', 'qwen3:14b', true],
    ['视觉模型', 'qwen2.5-vl:7b', false],
    ['代码模型', 'deepseek-coder:6.7b', false],
  ] as const
  const profiles = models.map(([displayName, modelId, isDefault]) => server!.store.saveModelProfile({
    workspaceId,
    providerId: provider.id,
    origin: 'imported',
    displayName,
    providerKind: provider.providerKind,
    baseUrl: provider.baseUrl,
    modelId,
    api: provider.api,
    isDefault,
    settings: {
      providerId: provider.id,
      providerName: provider.name,
      contextWindow: 32_768,
      inputTypes: ['text'],
      outputTypes: ['text'],
    },
  }))
  server.store.saveModelAssignment({ workspaceId, scope: 'workspace', scopeId: workspaceId, modelProfileId: profiles[0]!.id })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
  if (previousCatalogUrl === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalogUrl
})

test('opens the model hub from settings, shows the pool and remains responsive', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  const screenshotRoot = join(process.cwd(), 'artifacts', 'settings-model-ux')
  await mkdir(screenshotRoot, { recursive: true })

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: /AI 模型/ }).click()
  await expect(settings.getByText('新的 AI 模型管理中心', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: '打开模型中心', exact: true }).click()

  const hub = page.getByRole('dialog', { name: 'AI 模型管理中心' })
  await expect(hub).toBeVisible()
  await expect(hub.getByRole('button', { name: '模型服务商', exact: true })).toHaveAttribute('aria-current', 'true')
  await expect(hub.locator('.model-hub__provider-card')).toHaveCount(1)
  await expect(hub.locator('.model-hub__provider-card')).toContainText('Ollama')
  await expect(hub.locator('.model-hub__provider-card')).toContainText('安装 Ollama')

  await hub.getByRole('button', { name: '模型池', exact: true }).click()
  const pool = hub.locator('.model-hub__table')
  await expect(pool.locator('tbody tr')).toHaveCount(3)
  await expect(pool.getByText('32K', { exact: true })).toHaveCount(3)
  await expect(pool.getByText('Ollama', { exact: true })).toHaveCount(3)

  await hub.getByRole('button', { name: '模型设置', exact: true }).click()
  await expect(hub.locator('.model-hub__assign-targets button').first()).toContainText('全局')
  await expect(hub.locator('.model-hub__assign-current').first()).toContainText('本地推理模型')

  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize(viewport)
    const layout = await hub.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth + 1)
    await page.screenshot({ path: join(screenshotRoot, `model-hub-${viewport.label}.png`) })
  }

  await hub.getByRole('button', { name: '关闭模型中心' }).click()
  await expect(hub).toBeHidden()
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '关闭设置' }).click()
  await expect(page.getByRole('button', { name: '模型中心', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '模型中心', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI 模型管理中心' })).toBeVisible()
  await page.getByRole('button', { name: '关闭模型中心' }).click()
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})
