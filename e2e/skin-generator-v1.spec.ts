import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { SkinImportAnalyzeResult } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

/**
 * Phase G — Skin Generator, end to end: import a style file, analyze it with
 * a deterministic stub (CI never calls a cloud model), edit the palette,
 * publish, install the skin through the ordinary market review, apply it to
 * the current world and see the host restyle from the declared palette.
 */

let server: (CyberServer & { origin: string; root: string }) | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-skin-generator-v1-e2e-'))
  const analyzer = {
    async analyze(): Promise<SkinImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          displayName: '深夜图书馆',
          summary: '深蓝底色配暖黄阅读灯的安静阅读氛围。',
          palette: {
            accentColor: '#5aa9e6',
            pageBackground: '#0b1220',
            panelBackground: '#121c2e',
            textColor: '#eef2f7',
            ownerBubbleColor: '#1f3352',
            characterBubbleColor: '#16233a',
            backdropOpacity: 0.85,
          },
          sourceSummary: '来自 Markdown 皮肤描述。',
          sourceRefs: ['source:night-library-style.md'],
        },
        suggestedBackdropId: 'moonlit-tavern',
      }
    },
  }
  const created = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    skinImportAnalyzer: analyzer,
  } as any)
  const address = await created.start()
  server = Object.assign(created, { origin: address.origin, root: stateRoot })
  origin = address.origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('imports a style file, publishes only after review, installs the skin and applies it to the world', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)

  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const sourcePath = join(process.cwd(), 'tests', 'fixtures', 'skin-generator', 'night-library-style.md')
  const source = await readFile(sourcePath, 'utf8')
  const initialInstalled = current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)

  await page.goto(origin)
  await page.evaluate(() => {
    console.warn('GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels')
  })
  await page.getByRole('button', { name: '市场', exact: true }).click()
  const market = page.locator('.package-market-dialog')
  await expect(market).toBeVisible()
  await market.getByRole('button', { name: '皮肤', exact: true }).click()
  await expect(market.getByRole('textbox', { name: '搜索', exact: true })).toBeVisible()
  const customSkinButton = market.getByRole('button', { name: '自定义皮肤', exact: true })
  await expect(customSkinButton).toBeVisible()
  await customSkinButton.click()

  const generator = market.locator('.skin-generator')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(generator).toBeVisible()
  await expect(generator.getByText('创建方式', { exact: true })).toBeVisible()
  await generator.getByRole('radio', { name: '导入文件' }).click()
  await generator.locator('input[type="file"]').first().setInputFiles(sourcePath)
  await expect(generator.getByText(/已选择：night-library-style\.md/)).toBeVisible()
  await expect(generator.locator('textarea').first()).toHaveValue(source)

  await generator.getByRole('button', { name: '开始分析', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '正在整理配色' })).toBeVisible()
  await expect(generator.getByText('分析完成。请继续检查并编辑皮肤草稿')).toBeVisible()
  await generator.getByRole('button', { name: '检查皮肤草稿', exact: true }).click()

  await expect(generator.getByLabel('皮肤名称')).toBeVisible()
  await expect(generator.getByRole('textbox', { name: '强调色', exact: true })).toHaveValue('#5aa9e6')
  // The analyzer's backdrop suggestion is pre-selected; another official pick is one click.
  await expect(generator.getByRole('button', { name: '月影酒馆', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await generator.getByRole('button', { name: '千樱神殿', exact: true }).click()
  await expect(generator.getByRole('button', { name: '千樱神殿', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // Edit a colour; the hostile fixture text never reached a value.
  await generator.getByRole('textbox', { name: '强调色', exact: true }).fill('#F2A93B')
  await expect(generator.locator('.skin-generator-preview__action')).toHaveCSS('background-color', 'rgb(242, 169, 59)')
  await generator.getByLabel('皮肤名称').fill('深夜图书馆 · E2E')
  await generator.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '确认发布皮肤' })).toBeVisible()
  await expect(generator.getByText('发布不会自动安装或应用皮肤')).toBeVisible()

  await generator.getByRole('button', { name: '发布到皮肤市场', exact: true }).click()
  await expect(generator.getByText('皮肤已发布')).toBeVisible()
  expect(current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)).toEqual(initialInstalled)

  await generator.getByRole('button', { name: '查看并安装', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '扩展市场' })).toBeVisible()
  const skinCard = page.locator('.market-card-grid article').filter({ hasText: '深夜图书馆 · E2E' })
  await expect(skinCard).toBeVisible()
  await skinCard.getByRole('button', { name: '查看并安装', exact: true }).click()
  const permission = page.locator('.permission-review--market')
  await expect(permission).toBeVisible()
  await permission.getByRole('checkbox', { name: /我已审阅/ }).check()
  const installResponsePromise = page.waitForResponse((response) => response.url().includes('/marketplace/install'))
  await permission.getByRole('button', { name: /批准安装/ }).click()
  const installResponse = await installResponsePromise
  expect(installResponse.ok(), await installResponse.text()).toBe(true)

  const installed = current.store.listInstalledPackages(workspace.id).find((item) => item.packageId.startsWith('generated.skin.'))
  expect(installed?.kind).toBe('skin')
  expect(installed?.capabilities).toEqual(['ui:skin'])
  const packageId = installed!.packageId

  // Apply through the ordinary skin activation review.
  await expect(skinCard.getByRole('button', { name: '应用到当前世界', exact: true }), consoleIssues.join('\n')).toBeVisible()
  await skinCard.getByRole('button', { name: '应用到当前世界', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-skin', packageId)
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-accent').trim())).toBe('#f2a93b')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-bg').trim())).toBe('#0b1220')
  // The backdrop is the host's own sakura scene, resolved from the official id — the package carried no path.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-backdrop-image'))).toContain('sakura-shrine-world')
  const declared = await page.request.get(`${origin}/api/workspaces/${encodeURIComponent(workspace.id)}/skins`)
  const declaredItems = (await declared.json()).items as Array<{ packageId: string; manifest: { palette?: { accentColor: string }; backdropSkinId?: string } }>
  const generated = declaredItems.find((item) => item.packageId === packageId)
  expect(generated?.manifest.palette?.accentColor).toBe('#f2a93b')
  expect(generated?.manifest.backdropSkinId).toBe('sakura-shrine')
  expect(JSON.stringify(generated)).not.toMatch(/url\(|evil\.example|expression/u)

  // The skin survives a reload: the declared palette is registered before the switcher renders.
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-skin', packageId)
  await expect(page.getByRole('button', { name: /皮肤:/ })).toContainText('深夜图书馆 · E2E')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

function requireServer(): CyberServer & { origin: string; root: string } {
  if (server === undefined) throw new Error('Skin Generator E2E server is not started')
  return server
}
