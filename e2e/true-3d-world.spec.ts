import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

/**
 * The world is one place, drawn two ways.
 *
 * A note on what this file can and cannot check. Headless Chromium only offers
 * a software rasteriser, and the app deliberately refuses one — `supportsWebGl`
 * treats SwiftShader as no WebGL at all, so a device that cannot afford 3D is
 * never sent to download it. That refusal is the behaviour under test here, not
 * an obstacle to route around: forcing a GPU flag would prove the renderer runs
 * on hardware nobody in CI has, while hiding the degradation every low-end user
 * actually gets.
 *
 * So this covers the parts that are true in any browser: that renderer and
 * camera are separate choices, that choosing 3D never costs a second WebGL
 * context or an unwanted download, and that the world keeps running through
 * every switch. How the 3D scene itself is built, framed and levelled is
 * covered by unit tests over the pure modules, which need no GPU.
 */

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-true-3d-world-'))
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
})

async function canvasCount(page: Page): Promise<number> {
  return page.locator('canvas').count()
}

async function openWorld(page: Page): Promise<void> {
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.locator('.world-canvas-host')).toBeVisible()
}

test('draws the world in 2D by default and offers 3D as a way of drawing it', async ({ page }) => {
  await openWorld(page)

  const display = page.getByRole('tablist', { name: '世界显示方式' })
  await expect(display.getByRole('tab', { name: '2D', exact: true })).toHaveAttribute('aria-selected', 'true')
  // 3D is a renderer, not a character view: it is offered whether or not
  // anybody is selected, because it draws the whole company.
  await expect(display.getByRole('tab').nth(1)).toBeVisible()

  const camera = page.getByRole('tablist', { name: '世界镜头' })
  await expect(camera.getByRole('tab', { name: '全景', exact: true })).toBeVisible()
  await expect(camera.getByRole('tab', { name: '聚焦', exact: true })).toBeVisible()
})

test('keeps the world running across a renderer switch, with one canvas throughout', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => { if (/vrm-runtime|three-vrm|GLTFLoader/iu.test(request.url())) requests.push(request.url()) })
  await openWorld(page)

  const host = page.locator('.world-canvas-host')
  await expect(host).toHaveAttribute('data-renderer-kind', 'pixi-2d')
  const before = await canvasCount(page)

  // The 3D control names itself after what it will do — "3D" once a character
  // has an avatar, "创建 3D" before that — so it is addressed by position.
  await page.getByRole('tablist', { name: '世界显示方式' }).getByRole('tab').nth(1).click()
  await expect(host).toBeVisible()
  // On a machine with real WebGL this becomes three-3d. On this one the
  // degradation ladder ends at the 2D world — and, crucially, gets there
  // without downloading the renderer it decided it cannot run.
  await expect(host).toHaveAttribute('data-renderer-kind', /pixi-2d|three-3d/)
  expect(requests, '判定跑不动 3D 时不应先下载 3D 运行时').toEqual([])

  await page.getByRole('tab', { name: '2D', exact: true }).click()
  await expect(host).toHaveAttribute('data-renderer-kind', 'pixi-2d')
  // Switching never accumulates contexts: browsers cap them, and a world that
  // leaks one per switch dies after a handful.
  expect(await canvasCount(page)).toBeLessThanOrEqual(before)
})

test('moves the camera to a character instead of replacing the world', async ({ page }) => {
  await openWorld(page)
  const host = page.locator('.world-canvas-host')

  const camera = page.getByRole('tablist', { name: '世界镜头' })
  await camera.getByRole('tab', { name: '聚焦', exact: true }).click()
  await expect(camera.getByRole('tab', { name: '聚焦', exact: true })).toHaveAttribute('aria-selected', 'true')

  // The world is still there underneath. Before this, focusing a character
  // unmounted the canvas and mounted an unrelated view in its place.
  await expect(host).toBeVisible()
  await expect(host).toHaveAttribute('data-renderer-kind', 'pixi-2d')

  await camera.getByRole('tab', { name: '全景', exact: true }).click()
  await expect(host).toBeVisible()
})

test('keeps the world interactive while a character panel is open', async ({ page }) => {
  await openWorld(page)
  // The world's own selection surface. It is visually hidden — the canvas
  // draws the characters — so it is driven rather than clicked.
  const character = page.getByRole('button', { name: /世界角色$/ }).first()
  await expect(character).toBeAttached()
  await character.dispatchEvent('click')

  // Selecting somebody must not take the world away, and the view controls
  // must stay reachable rather than being covered by the panel.
  await expect(page.locator('.world-canvas-host')).toBeVisible()
  await expect(page.getByRole('tablist', { name: '世界镜头' })).toBeVisible()
})

test('remembers how a world was being looked at', async ({ page }) => {
  await openWorld(page)
  await page.getByRole('tablist', { name: '世界镜头' }).getByRole('tab', { name: '全景', exact: true }).click()
  await page.reload()
  await expect(page.locator('.world-canvas-host')).toBeVisible()
  await expect(page.getByRole('tablist', { name: '世界镜头' }).getByRole('tab', { name: '全景', exact: true }))
    .toHaveAttribute('aria-selected', 'true')
})
