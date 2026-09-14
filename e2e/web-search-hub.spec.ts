import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
const previousCatalogUrl = process.env.DSH_CYBER_MODEL_CATALOG_URL

test.beforeAll(async () => {
  // Keep the hub contract deterministic and offline: no remote model catalog.
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-web-search-hub-'))
  await mkdir(join(process.cwd(), 'artifacts', 'web-search-hub'), { recursive: true })
  server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
  if (previousCatalogUrl === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL
  else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalogUrl
})

async function openWebSearchSection(page: Page): Promise<Locator> {
  // 入口在正常视觉流中可见可点，不用隐藏镜像或脚本点击。
  const entry = page.getByRole('button', { name: '连接中心', exact: true })
  await expect(entry).toBeVisible()
  await entry.click()
  const hub = page.getByRole('dialog', { name: '连接中心' })
  await expect(hub).toBeVisible()
  const webSearchItem = hub.locator('.integration-provider-list button', { hasText: '联网搜索' })
  await expect(webSearchItem).toBeVisible()
  await webSearchItem.click()
  return hub
}

/** Open a card's editor, fill its key, optionally mark it default, and save. */
async function configureCard(hub: Locator, providerId: string, key: string, makeDefault: boolean): Promise<void> {
  const card = hub.locator(`.web-search-card[data-provider-id="${providerId}"]`)
  const openButton = card.getByRole('button', { name: /设置|编辑/ }).first()
  await openButton.click()
  await card.locator('input[type="password"]').fill(key)
  const defaultCheckbox = card.getByRole('checkbox', { name: /设为默认搜索服务商/ })
  if (makeDefault) await defaultCheckbox.check()
  await card.getByRole('button', { name: '保存', exact: true }).click()
}

test('联网搜索主项：固定服务商卡片、接管 Firecrawl、跨卡片归一默认', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.setViewportSize({ width: 1_584, height: 992 })
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()

  const hub = await openWebSearchSection(page)

  // 服务商是固定卡片（目录来自仓库 JSON），不再是下拉框；旧「Firecrawl」主项被接管。
  await expect(hub.locator('.web-search-card[data-provider-id="deepseek"]')).toBeVisible()
  await expect(hub.locator('.web-search-card[data-provider-id="firecrawl"]')).toBeVisible()
  await expect(hub.locator('.web-search-card select')).toHaveCount(0)
  await expect(hub.locator('.integration-provider-list button', { hasText: 'Firecrawl' })).toHaveCount(0)

  // 卡片平铺：服务地址、服务说明、获取途径。
  const deepseekCard = hub.locator('.web-search-card[data-provider-id="deepseek"]')
  await expect(deepseekCard).toContainText('https://api.deepseek.com/anthropic/v1')
  await expect(deepseekCard.locator('a')).toHaveAttribute('href', 'https://platform.deepseek.com/api_keys')

  // DeepSeek 卡片：设密钥 + 设为默认 → 列表标注「默认」。
  await configureCard(hub, 'deepseek', 'sk-e2e-test-key', true)
  await expect(deepseekCard.locator('.web-search-card__badge', { hasText: '默认' })).toBeVisible()
  await expect(deepseekCard.locator('.web-search-card__status')).toHaveText('密钥已配置')

  // Firecrawl 卡片（接管旧连接）：设密钥 + 设为默认 → 跨类型归一掉 DeepSeek 的默认标记。
  await configureCard(hub, 'firecrawl', 'fc-e2e-test-key', true)
  const firecrawlCard = hub.locator('.web-search-card[data-provider-id="firecrawl"]')
  await expect(firecrawlCard.locator('.web-search-card__badge', { hasText: '默认' })).toBeVisible()
  await expect(firecrawlCard.locator('.web-search-card__status')).toHaveText('密钥已配置')
  await expect(deepseekCard.locator('.web-search-card__badge')).toHaveCount(0)

  // 关闭后入口仍在（信息架构不随弹窗关闭丢失）。
  await hub.getByRole('button', { name: '关闭连接中心' }).click()
  await expect(page.getByRole('button', { name: '连接中心', exact: true })).toBeVisible()

  expect(issues.filter((issue) => issue.startsWith('[console:error]') || issue.startsWith('[pageerror]'))).toEqual([])
})

/**
 * AGENTS.md 视觉审批证据：在弹窗内测量最小字号、正文对比度（WCAG）、
 * 弹窗是否铺满/越界，并采集全部可见文案用于语言一致性审查。
 */
async function auditHubViewport(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.connection-hub')
    if (root === null) throw new Error('连接中心弹窗未打开')
    const parseColor = (value: string): [number, number, number, number] => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (match === null) return [0, 0, 0, 1]
      const parts = match[1].split(',').map((item) => Number.parseFloat(item.trim()))
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts.length === 4 ? (parts[3] ?? 1) : 1]
    }
    const luminance = ([r, g, b]: number[]): number => {
      const channel = (value: number): number => {
        const scaled = value / 255
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const effectiveBackground = (element: Element): [number, number, number] => {
      let node: Element | null = element
      while (node !== null) {
        const [r, g, b, a] = parseColor(getComputedStyle(node).backgroundColor)
        if (a > 0) return [r, g, b]
        node = node.parentElement
      }
      return [255, 255, 255]
    }
    const texts: Array<{ text: string; fontSize: number; contrast: number }> = []
    for (const leaf of root.querySelectorAll<HTMLElement>('*')) {
      const ownText = [...leaf.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== '').map((node) => node.textContent?.trim() ?? '').join('')
      if (ownText === '') continue
      const style = getComputedStyle(leaf)
      if (style.display === 'none' || style.visibility === 'hidden' || style.fontSize === '0px') continue
      const fontSize = Number.parseFloat(style.fontSize)
      const [cr, cg, cb] = parseColor(style.color)
      const background = effectiveBackground(leaf)
      const lighter = Math.max(luminance([cr, cg, cb]), luminance(background))
      const darker = Math.min(luminance([cr, cg, cb]), luminance(background))
      const contrast = (lighter + 0.05) / (darker + 0.05)
      texts.push({ text: ownText, fontSize, contrast: Math.round(contrast * 100) / 100 })
    }
    const viewportBox = { width: window.innerWidth, height: window.innerHeight }
    const dialogBox = root.getBoundingClientRect()
    const minFont = Math.min(...texts.map((item) => item.fontSize))
    const worstContrast = Math.min(...texts.map((item) => item.contrast))
    const mixedLanguage = texts.filter((item) => /[\u4e00-\u9fff]/.test(item.text) && /[\x20-\x7e]/.test(item.text)).map((item) => item.text)
    return {
      viewport: viewportBox,
      dialog: { x: dialogBox.x, y: dialogBox.y, width: dialogBox.width, height: dialogBox.height, fits: dialogBox.width <= viewportBox.width && dialogBox.height <= viewportBox.height },
      minFontSize: minFont,
      worstContrastRatio: worstContrast,
      lowContrastTexts: texts.filter((item) => item.contrast < 4.5).map((item) => `${item.text} (${item.contrast})`),
      smallTexts: texts.filter((item) => item.fontSize < 12).map((item) => `${item.text} (${item.fontSize}px)`),
      mixedLanguageTexts: [...new Set(mixedLanguage)],
      textSample: texts.map((item) => item.text).slice(0, 80),
    }
  })
}

interface ViewportAudit {
  [key: string]: unknown
  viewport: string
}

test('联网搜索设置页三视口视觉审批', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  const audit: { consoleIssues: string[]; viewports: ViewportAudit[] } = { consoleIssues: issues, viewports: [] }
  for (const viewport of [
    { width: 1_440, height: 900, name: '1440x900' },
    { width: 1_920, height: 1_080, name: '1920x1080' },
    { width: 3_840, height: 2_160, name: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(origin)
    await expect(page.locator('.workbench-shell')).toBeVisible()
    const hub = await openWebSearchSection(page)
    // 停在服务商卡片态（卡片平铺展示：服务地址、说明、获取途径）。
    audit.viewports.push({ ...(await auditHubViewport(page)) as Record<string, unknown>, viewport: viewport.name })
    await page.screenshot({ path: join(process.cwd(), 'artifacts', 'web-search-hub', `web-search-hub-${viewport.name}.png`) })
    await hub.getByRole('button', { name: '关闭连接中心' }).click()
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(process.cwd(), 'artifacts', 'web-search-hub', 'web-search-hub-audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  for (const entry of audit.viewports) {
    expect(Number(entry.minFontSize), `${entry.viewport} 辅助文字不小于 12px`).toBeGreaterThanOrEqual(12)
    expect(entry.dialog, `${entry.viewport} 弹窗铺满且未越出视口`).toMatchObject({ fits: true })
  }
  expect(issues.filter((issue) => issue.startsWith('[console:error]') || issue.startsWith('[pageerror]'))).toEqual([])
})
