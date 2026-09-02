import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { WorldImportAnalyzeResult } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

/**
 * Phase G — World Generator, end to end: import a scenario file, analyze it
 * with a deterministic stub (CI never calls a cloud model), edit the draft,
 * publish, install the theme through the ordinary market review, and create a
 * world from it. The cast rides along as ordinary talent packages.
 */

let server: (CyberServer & { origin: string; root: string }) | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-generator-v1-e2e-'))
  const analyzer = {
    async analyze(): Promise<WorldImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          targetWorldTemplateId: 'personal-world',
          displayName: '社区法律援助诊所',
          summary: '面向社区居民的小型法律援助诊所，只做前期梳理、材料准备和转介。',
          terminology: { world: '诊所', participant: '成员', session: '案情会', milestone: '办案记录' },
          workflow: ['来访登记', '问题梳理', '法律评估', '材料准备', '转介或结案'],
          rules: ['只根据来访者提供的材料判断，不替来访者补事实。', '涉及时效的问题必须当天告知来访者。'],
          cast: [
            {
              schemaVersion: 1, targetWorldTemplateId: 'personal-world', displayName: '值班律师', role: '法律评估',
              summary: '负责法律评估和最终建议。', persona: '只依据来访者提供的材料判断，时效问题当天标红。',
              personalityTraits: ['审慎'], background: '', requestedSkillIds: [], requestedCapabilities: [],
              sourceSummary: '来自世界资料。', sourceRefs: ['source:legal-clinic-scenario.md'],
            },
            {
              schemaVersion: 1, targetWorldTemplateId: 'personal-world', displayName: '案件助理', role: '事实整理',
              summary: '整理事实、准备材料、跟进进度。', persona: '把口述整理成事实清单和时间线，不替来访者补事实。',
              personalityTraits: [], background: '', requestedSkillIds: [], requestedCapabilities: [],
              sourceSummary: '来自世界资料。', sourceRefs: ['source:legal-clinic-scenario.md'],
            },
          ],
          sourceSummary: '来自 Markdown 世界资料。',
          sourceRefs: ['source:legal-clinic-scenario.md'],
        },
        suggestedSceneId: 'official-moonlit-tavern',
      }
    },
  }
  const created = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    worldImportAnalyzer: analyzer,
  } as any)
  const address = await created.start()
  server = Object.assign(created, { origin: address.origin, root: stateRoot })
  origin = address.origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('imports a scenario file, publishes only after review, installs the theme and creates a world from it', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)

  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const sourcePath = join(process.cwd(), 'tests', 'fixtures', 'world-generator', 'legal-clinic-scenario.md')
  const source = await readFile(sourcePath, 'utf8')
  const initialWorlds = current.store.listWorlds(workspace.id).length
  const initialInstalled = current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)

  await page.goto(origin)
  await page.evaluate(() => {
    console.warn('GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels')
  })
  await page.getByRole('button', { name: '市场', exact: true }).click()
  const market = page.locator('.package-market-dialog')
  await expect(market).toBeVisible()
  await market.getByRole('button', { name: '世界', exact: true }).click()
  await expect(market.getByRole('textbox', { name: '搜索', exact: true })).toBeVisible()
  const customWorldButton = market.getByRole('button', { name: '自定义世界', exact: true })
  await expect(customWorldButton).toBeVisible()
  await customWorldButton.click()

  const generator = market.locator('.world-generator')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(generator).toBeVisible()
  await expect(generator.getByText('创建方式', { exact: true })).toBeVisible()
  await generator.getByRole('radio', { name: '导入文件' }).click()
  await generator.locator('input[type="file"]').first().setInputFiles(sourcePath)
  await expect(generator.getByText(/已选择：legal-clinic-scenario\.md/)).toBeVisible()
  await expect(generator.locator('textarea').first()).toHaveValue(source)

  await generator.getByRole('button', { name: '开始分析', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '正在整理世界设定' })).toBeVisible()
  await expect(generator.getByText('分析完成。请继续检查并编辑世界草稿')).toBeVisible()
  await generator.getByRole('button', { name: '检查世界草稿', exact: true }).click()

  await expect(generator.getByLabel('世界名称')).toBeVisible()
  await expect(generator.getByLabel('世界称谓')).toHaveValue('诊所')
  await expect(generator.getByText('来访登记', { exact: true })).toBeVisible()
  await expect(generator.getByText('值班律师', { exact: true })).toBeVisible()
  // The analyzer's scene suggestion is pre-selected; another official pick is one click.
  await expect(generator.getByRole('button', { name: /月影酒馆/ })).toHaveAttribute('aria-pressed', 'true')
  await generator.getByRole('button', { name: /远星观测站/ }).click()
  await expect(generator.getByRole('button', { name: /远星观测站/ })).toHaveAttribute('aria-pressed', 'true')
  // Upload a background: it replaces the scene image only, the official pick
  // above keeps the layout and stays pressed.
  await generator.locator('.world-generator-scene input[type="file"]').setInputFiles({ name: 'backdrop.png', mimeType: 'image/png', buffer: UPLOADED_BACKGROUND_PNG })
  await expect(generator.getByText(/已选择背景图片：backdrop\.png/).first()).toBeVisible()
  await expect(generator.getByRole('button', { name: /远星观测站/ })).toHaveAttribute('aria-pressed', 'true')
  await generator.getByLabel('世界名称').fill('社区法律援助诊所 · E2E')
  await generator.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '确认发布世界主题' })).toBeVisible()
  await expect(generator.getByText('发布不会自动安装、创建世界或招募角色')).toBeVisible()

  await generator.getByRole('button', { name: '发布到世界市场', exact: true }).click()
  await expect(generator.getByText('世界主题已发布')).toBeVisible()
  expect(current.store.listWorlds(workspace.id)).toHaveLength(initialWorlds)
  expect(current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)).toEqual(initialInstalled)

  await generator.getByRole('button', { name: '查看并安装', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '扩展市场' })).toBeVisible()
  const themeCard = page.locator('.market-card-grid article').filter({ hasText: '社区法律援助诊所 · E2E' })
  await expect(themeCard).toBeVisible()
  await themeCard.getByRole('button', { name: '查看并安装', exact: true }).click()
  const permission = page.locator('.permission-review--market')
  await expect(permission).toBeVisible()
  await permission.getByRole('checkbox', { name: /我已审阅/ }).check()
  const installResponsePromise = page.waitForResponse((response) => response.url().includes('/marketplace/install'))
  await permission.getByRole('button', { name: /批准安装/ }).click()
  const installResponse = await installResponsePromise
  expect(installResponse.ok(), await installResponse.text()).toBe(true)

  await expect(themeCard.getByRole('button', { name: '创建新世界', exact: true }), consoleIssues.join('\n')).toBeVisible()
  await themeCard.getByRole('button', { name: '创建新世界', exact: true }).click()
  const creation = page.locator('.world-creation-review')
  await expect(creation).toBeVisible()
  await creation.getByLabel('新世界名称').fill('诊所世界')
  const createResponsePromise = page.waitForResponse((response) => response.url().includes('/marketplace/worlds'))
  await creation.getByRole('button', { name: '创建并进入这个世界', exact: true }).click()
  const createResponse = await createResponsePromise
  expect(createResponse.ok(), await createResponse.text()).toBe(true)

  const createdWorld = current.store.listWorlds(workspace.id).find((world) => world.name === '诊所世界')
  expect(createdWorld).toBeDefined()
  expect(createdWorld!.templateId).toBe('personal-world')
  const binding = current.store.getWorldThemeBinding(createdWorld!.id)
  expect(binding?.status).toBe('active')
  expect(binding?.themeId).toMatch(/^generated\.world\./u)
  expect(binding?.manifest.terminology).toMatchObject({ world: '诊所', session: '案情会' })
  expect(binding?.manifest.scenes[0]?.id).toBe('blue-ring-deck')
  // The uploaded raster is the theme's background asset; the official scene's own image is gone.
  expect(binding?.manifest.assets.map((asset) => asset.src)).toContain('assets/background.png')
  expect(binding?.manifest.assets.map((asset) => asset.src)).not.toContain('assets/orbital-observatory-world.png')
  const previewResponse = await page.request.get(`${origin}/api/marketplace/packages/${encodeURIComponent(binding!.packageId)}/${binding!.packageVersion}/preview?workspaceId=${encodeURIComponent(workspace.id)}`)
  expect(previewResponse.ok()).toBe(true)
  expect(Buffer.from(await previewResponse.body()).equals(UPLOADED_BACKGROUND_PNG)).toBe(true)

  // The cast was published as ordinary talent packages, installed by nobody yet.
  const talent = await page.request.get(`${origin}/api/marketplace?market=talent&workspaceId=${encodeURIComponent(workspace.id)}`)
  const talentItems = (await talent.json()).items as Array<{ manifest: { id: string; displayName: string } }>
  expect(talentItems.filter((item) => item.manifest.id.startsWith('generated.character.')).map((item) => item.manifest.displayName).sort()).toEqual(['值班律师', '案件助理'])
  expect(current.store.listInstalledPackages(workspace.id).filter((item) => item.packageId.startsWith('generated.character.'))).toHaveLength(0)
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

// A 1x1 opaque PNG: small enough to inline, a real container for the sniffer.
const UPLOADED_BACKGROUND_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function requireServer(): CyberServer & { origin: string; root: string } {
  if (server === undefined) throw new Error('World Generator E2E server is not started')
  return server
}
