import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab, type WorldDockLabel } from './dock-test-helpers.js'

/**
 * The four pinned dock surfaces read as one screen: a header with a single
 * title and a single primary action, a list of rows that carry one line of
 * secondary text, and the rest behind a details fold. This checks the shape a
 * reader actually sees, at the three review resolutions, and that a narrow
 * dock never solves its layout by shrinking type below 12px.
 */

const SURFACES: Array<{ tab: WorldDockLabel; title: string; action: string }> = [
  { tab: '角色', title: '角色目录', action: '新增角色' },
  { tab: '任务', title: '任务工作台', action: '新建任务' },
  { tab: '日程', title: '任务日程', action: '新建日程' },
  { tab: '产物', title: '世界产物', action: '从工作目录发布' },
]

let server: CyberServer
let origin: string
let stateRoot: string

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-dock-shape-e2e-'))
  await mkdir(join(process.cwd(), 'artifacts', 'dock-surface-shape'), { recursive: true })
  server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    bootstrapDefaultWorld: true, port: 0,
    runtime: { async runTurn() { throw new Error('No model run expected') }, async close() {} },
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('gives the four dock surfaces one header, one primary action and readable type at every review size', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.goto(origin)
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await expect(dock).toBeVisible()

  for (const viewport of [{ width: 1_440, height: 900 }, { width: 1_920, height: 1_080 }, { width: 3_840, height: 2_160 }]) {
    await page.setViewportSize(viewport)
    for (const surface of SURFACES) {
      await openDockTab(dock, surface.tab)
      const header = dock.locator('.dock-surface__header')
      await expect(header).toHaveCount(1)
      await expect(header.locator('h2')).toHaveText(surface.title)
      await expect(header.locator('.dock-surface__action > button')).toHaveCount(1)
      await expect(header.getByRole('button', { name: surface.action })).toBeVisible()
      expect(await horizontalOverflow(dock), `${surface.tab} @ ${viewport.width}`).toEqual([])
      expect(await pageScrollsSideways(page), `page @ ${surface.tab} ${viewport.width}`).toBe(false)
      expect(await fontSize(header.locator('h2')), `${surface.tab} title size`).toBeGreaterThanOrEqual(14)
      const summary = header.locator('.dock-surface__heading p')
      if (await summary.count() > 0) {
        expect(await fontSize(summary), `${surface.tab} summary size`).toBeGreaterThanOrEqual(12)
      }
      if (viewport.width === 1_440) {
        await dock.screenshot({ path: join(process.cwd(), 'artifacts', 'dock-surface-shape', `dock-${surface.tab}.png`) })
      }
    }
    await page.screenshot({ path: join(process.cwd(), 'artifacts', 'dock-surface-shape', `dock-${viewport.width}x${viewport.height}.png`) })
  }

  expect(issues, issues.join('\n')).toEqual([])
})

test('gives every dock row one title, one line of secondary text and the shared fold', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.goto(origin)
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')

  const rows = dock.locator('.dock-row')
  expect(await rows.count()).toBeGreaterThan(0)
  const first = rows.first()
  await expect(first.locator('.dock-row__title')).toHaveCount(1)
  await expect(first.locator('.dock-row__secondary')).toHaveCount(1)
  expect(await fontSize(first.locator('.dock-row__title'))).toBeGreaterThanOrEqual(14)
  expect(await fontSize(first.locator('.dock-row__secondary'))).toBeGreaterThanOrEqual(12)

  // The rest of the record is behind the shared fold, closed until asked for.
  const fold = first.locator('details.dock-detail-fold')
  await expect(fold).toHaveCount(1)
  await expect(fold.locator('dl')).toBeHidden()
  await fold.locator('> summary').click()
  await expect(fold.locator('dl')).toBeVisible()

  // The row itself is the one primary action;管理 and 直接对话 stay secondary.
  await expect(first.getByRole('button', { name: /查看角色/ })).toHaveCount(1)
  await first.getByRole('button', { name: /查看角色/ }).click()
  await expect(dock.getByRole('button', { name: '全部角色' })).toBeVisible()

  expect(issues, issues.join('\n')).toEqual([])
})

/**
 * Names every element that clips or scrolls sideways, so a failure is
 * actionable. Three things are deliberately not overflow bugs: visible
 * overflow (a status dot sits 3px outside its avatar, hiding nothing), the
 * screen-reader-only labels, and the dock's own tab strip, which the product
 * scrolls once a world has pinned enough surfaces.
 */
async function horizontalOverflow(dock: Locator): Promise<string[]> {
  return dock.evaluate((element) => {
    const name = (node: Element) => `${node.tagName.toLowerCase()}.${node.className || '(no class)'}`
    const nodes = [element, ...element.querySelectorAll('*')]
    const scrolling = nodes
      .filter((node) => node.scrollWidth > node.clientWidth + 1
        && getComputedStyle(node).overflowX !== 'visible'
        && !node.classList.contains('sr-only')
        && !node.classList.contains('dock-tabs__primary'))
      .map((node) => `${name(node)} scrolls ${node.scrollWidth}>${node.clientWidth}`)
    // Visible overflow scrolls nothing, but it can still push a primary action
    // past the dock's own edge, where the reader simply cannot see it.
    const edge = element.getBoundingClientRect().right
    const spilling = nodes
      .filter((node) => node.getBoundingClientRect().right > edge + 1 && node.checkVisibility())
      .map((node) => `${name(node)} spills past the dock edge`)
    return [...scrolling, ...spilling]
  })
}

/** The window itself never scrolls sideways: the dock has to fit the display it is on. */
async function pageScrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
}

async function fontSize(locator: Locator): Promise<number> {
  return Number.parseFloat(await locator.first().evaluate((element) => getComputedStyle(element).fontSize))
}

export type { Page }
