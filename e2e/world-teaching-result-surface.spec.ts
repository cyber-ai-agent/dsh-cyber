import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { openDockTab } from './dock-test-helpers.js'

const BOARD_TITLE = '一次函数板书'
const LESSON_TITLE = '一次函数课程卡'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-teaching-surface-e2e-'))
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
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('the world scene area presents published teaching results and stays honest when there are none', async ({ page }) => {
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '世界')

  // An empty world must say so instead of drawing a board with nothing on it.
  await page.getByRole('button', { name: '世界结果', exact: true }).click()
  const surface = page.locator('.world-runtime-dock__canvas .teaching-surface')
  await expect(surface).toBeVisible()
  await expect(surface.getByText('这个世界还没有可展示的结果')).toBeVisible()
  await expect(surface.locator('.teaching-board')).toHaveCount(0)

  // Publish one board artifact and one lesson-card artifact through the
  // existing world artifact service, exactly like a character run would.
  const filesRoot = join(stateRoot, 'worlds', encodeURIComponent(world.id), 'files', 'teaching')
  await mkdir(filesRoot, { recursive: true })
  await writeFile(join(filesRoot, 'board.md'), '# 一次函数\n\n- 斜率 k 决定倾斜方向\n- 截距 b 决定与 y 轴的交点\n', 'utf8')
  await writeFile(join(filesRoot, 'lesson.json'), JSON.stringify({
    cards: [{ title: '第一课 · 认识斜率', summary: '从图像读出 k', points: ['画出 y=kx+b', '比较 k>0 与 k<0'] }],
  }), 'utf8')
  await publish(world.id, { workspaceId: workspace.id, title: BOARD_TITLE, kind: 'markdown', sourceRelativePath: 'teaching/board.md' })
  await publish(world.id, { workspaceId: workspace.id, title: LESSON_TITLE, kind: 'data', sourceRelativePath: 'teaching/lesson.json' })

  await page.reload()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '世界')
  await page.getByRole('button', { name: '世界结果', exact: true }).click()
  const results = page.locator('.world-runtime-dock__canvas .teaching-surface')
  await expect(results).toBeVisible()

  // 板书: the worked-through content is presented on the board in the scene area.
  const board = results.locator('.teaching-board')
  await expect(board).toBeVisible()
  await expect(board).toContainText(BOARD_TITLE)
  await expect(board).toContainText('斜率 k 决定倾斜方向')

  // 课程卡片: the structured lesson artifact becomes cards.
  await results.getByRole('tab', { name: /结果卡片/ }).click()
  await expect(results.locator('.teaching-card')).toContainText('第一课 · 认识斜率')
  await expect(results.locator('.teaching-card')).toContainText('比较 k>0 与 k<0')

  // 知识图: the lane reuses the existing world knowledge graph, empty state included.
  await results.getByRole('tab', { name: /知识图/ }).click()
  await expect(results.getByRole('region', { name: '知识图谱空状态' })).toBeVisible()

  // The surface stays inside the scene area and never overflows it horizontally,
  // at every production resolution the product supports.
  await results.getByRole('tab', { name: /结果板/ }).click()
  await expect(results.locator('.teaching-board')).toBeVisible()
  for (const size of [{ width: 1_440, height: 900 }, { width: 1_920, height: 1_080 }, { width: 3_840, height: 2_160 }]) {
    await page.setViewportSize(size)
    const overflow = await page.evaluate(() => {
      const element = document.querySelector('.teaching-surface')
      const body = document.body
      return element === null ? undefined : {
        surface: element.scrollWidth - element.clientWidth,
        page: body.scrollWidth - body.clientWidth,
      }
    })
    expect(overflow, `no horizontal overflow at ${size.width}x${size.height}`).toBeDefined()
    expect(overflow!.surface, `surface overflow at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
    expect(overflow!.page, `page overflow at ${size.width}x${size.height}`).toBeLessThanOrEqual(1)
  }
  await page.setViewportSize({ width: 1_584, height: 992 })

  // Escape returns focus to the toggle that opened the surface.
  await results.press('Escape')
  await expect(results).toHaveCount(0)
  await expect(page.getByRole('button', { name: '世界结果', exact: true })).toBeFocused()
})

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('Teaching result surface E2E server is not running')
  return server
}

async function publish(worldId: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${origin}/api/worlds/${encodeURIComponent(worldId)}/artifacts/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect([200, 201], await response.text().catch(() => '')).toContain(response.status)
}
