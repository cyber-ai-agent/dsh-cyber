import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

/**
 * 3D is an optional extension, and the core world must not pay for it.
 *
 * The core world is drawn by Pixi and offers two views of itself — the map and
 * the 2D character view. Three.js and VRM live behind the 世界扩展 dialog,
 * off by default, and nothing about them may reach the first screen: no bytes,
 * no GPU probe, no second WebGL context. That boundary is what this file
 * checks, from the outside, the way a user crosses it.
 *
 * A note on what this file can and cannot check. Headless Chromium only offers
 * a software rasteriser, and the app deliberately refuses one — `supportsWebGl`
 * treats a headless UA and SwiftShader as no WebGL at all, so a device that
 * cannot afford 3D is never sent to download it. That refusal is behaviour
 * under test here, not an obstacle to route around: forcing a GPU flag would
 * prove the renderer runs on hardware nobody in CI has, while hiding the
 * degradation every low-end user actually gets. So the extension is asserted to
 * load, announce that this device cannot draw it, and still not fetch Three.
 * How the 3D scene itself is built, framed and levelled is covered by unit
 * tests over the pure modules, which need no GPU.
 */

/** Chunks that may only ever be fetched by an explicitly enabled 3D extension. */
const SPATIAL_RUNTIME = /vrm-runtime|three-vrm|three-world|GLTFLoader/iu

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

/** Every asset the page has asked the server for, in order. */
function trackAssets(page: Page): { all: string[]; spatialRuntime: string[] } {
  const all: string[] = []
  const spatialRuntime: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (/\/assets\//u.test(url)) all.push(url)
    if (SPATIAL_RUNTIME.test(url)) spatialRuntime.push(url)
  })
  return { all, spatialRuntime }
}

async function openWorld(page: Page): Promise<void> {
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.locator('.world-canvas-host')).toBeVisible()
}

function extensionsDialog(page: Page) {
  return page.getByRole('dialog', { name: /^世界扩展/u })
}

function spatialDialog(page: Page) {
  return page.getByRole('dialog', { name: /^3D 空间扩展/u })
}

async function openExtensions(page: Page): Promise<void> {
  await page.getByRole('button', { name: '世界扩展', exact: true }).click()
  await expect(extensionsDialog(page)).toBeVisible()
}

test('draws the core world without 3D and fetches none of its runtime', async ({ page }) => {
  const assets = trackAssets(page)
  await openWorld(page)

  const host = page.locator('.world-canvas-host')
  await expect(host).toHaveAttribute('data-renderer-kind', 'pixi-2d')

  // The core dock offers two views of one Pixi world. 3D is not among them:
  // it is an extension with its own dialog, not a renderer choice here.
  const display = page.getByRole('tablist', { name: '世界显示方式' })
  await expect(display.getByRole('tab')).toHaveText(['平面', '2D'])
  await expect(display.getByRole('tab', { name: '平面', exact: true })).toHaveAttribute('aria-selected', 'true')

  expect(assets.spatialRuntime, '首屏不应下载 Three/VRM 运行时').toEqual([])
  expect(await page.locator('canvas').count()).toBe(1)
})

test('offers 3D as an extension that is off until it is asked for', async ({ page }) => {
  const assets = trackAssets(page)
  await openWorld(page)
  const beforeDialog = assets.all.length
  await openExtensions(page)

  const card = extensionsDialog(page).locator('.world-extensions-dialog__card')
  await expect(card).toContainText('3D 空间')
  await expect(card).toContainText('可选')
  await expect(card.getByRole('button', { name: '启用扩展' })).toBeVisible()
  // Nothing can be opened before it is enabled.
  await expect(card.getByRole('button', { name: '打开 3D 空间' })).toHaveCount(0)

  // Reading the extension list is not enabling it: the manager itself never
  // imports the 3D runtime.
  expect(assets.spatialRuntime, '仅打开扩展列表不应下载 3D 运行时').toEqual([])
  expect(assets.all.slice(beforeDialog).filter((url) => SPATIAL_RUNTIME.test(url))).toEqual([])
})

test('loads the extension when enabled, and refuses to draw it without real WebGL', async ({ page }) => {
  const assets = trackAssets(page)
  await openWorld(page)
  await openExtensions(page)

  const beforeEnable = new Set(assets.all)
  await extensionsDialog(page).getByRole('button', { name: '启用扩展' }).click()
  await extensionsDialog(page).getByRole('button', { name: '打开 3D 空间' }).click()

  const spatial = spatialDialog(page)
  await expect(spatial).toBeVisible()
  // The dialog only exists once its lazy chunk arrives, so rendering it proves
  // the extension was fetched on demand rather than shipped with the world.
  const loadedOnDemand = assets.all.filter((url) => !beforeEnable.has(url) && url.endsWith('.js'))
  expect(loadedOnDemand.length, '启用扩展后应按需下载扩展代码').toBeGreaterThan(0)

  // Software WebGL is refused rather than rendered badly, and the refusal is
  // reached without downloading the renderer it just decided it cannot run.
  await expect(spatial.locator('.spatial-world-extension__unavailable')).toContainText('当前设备未启用 3D 空间')
  await expect(spatial.locator('[data-renderer-kind="three-3d"]')).toHaveCount(0)
  expect(assets.spatialRuntime, '判定跑不动 3D 时不应下载 Three/VRM 运行时').toEqual([])
})

test('keeps the core world running across the extension, without accumulating canvases', async ({ page }) => {
  await openWorld(page)
  const host = page.locator('.world-canvas-host')
  // Mark the live host element. React remounting it would replace the node and
  // lose the mark along with the running world.
  await host.evaluate((element) => { element.setAttribute('data-e2e-world-instance', 'first') })
  const canvasesBefore = await page.locator('canvas').count()

  await openExtensions(page)
  await extensionsDialog(page).getByRole('button', { name: '启用扩展' }).click()

  for (const pass of ['first', 'second']) {
    await extensionsDialog(page).getByRole('button', { name: '打开 3D 空间' }).click()
    await expect(spatialDialog(page)).toBeVisible()
    // The core world is not unmounted or paused to make room for the extension.
    await expect(host).toBeVisible()
    await expect(host).toHaveAttribute('data-e2e-world-instance', 'first')
    await expect(host).toHaveAttribute('data-renderer-kind', 'pixi-2d')
    // At most the extension's own surface is added while it is open.
    expect(await page.locator('canvas').count(), `${pass} open`).toBeLessThanOrEqual(canvasesBefore + 1)

    await spatialDialog(page).getByRole('button', { name: '关闭 3D 空间扩展' }).click()
    await expect(spatialDialog(page)).toHaveCount(0)
    // Browsers cap WebGL contexts: a world that leaks one per open/close dies
    // after a handful of visits.
    expect(await page.locator('canvas').count(), `${pass} close`).toBe(canvasesBefore)
    await expect(host).toHaveAttribute('data-e2e-world-instance', 'first')

    await openExtensions(page)
  }
})

test('stops loading the extension once it is disabled', async ({ page }) => {
  const assets = trackAssets(page)
  await openWorld(page)
  await openExtensions(page)

  const beforeEnable = new Set(assets.all)
  await extensionsDialog(page).getByRole('button', { name: '启用扩展' }).click()
  await extensionsDialog(page).getByRole('button', { name: '打开 3D 空间' }).click()
  await expect(spatialDialog(page)).toBeVisible()
  const extensionAssets = assets.all.filter((url) => !beforeEnable.has(url))
  expect(extensionAssets.length).toBeGreaterThan(0)

  await spatialDialog(page).getByRole('button', { name: '关闭 3D 空间扩展' }).click()
  await openExtensions(page)
  await extensionsDialog(page).getByRole('button', { name: '停用' }).click()
  await expect(extensionsDialog(page).getByRole('button', { name: '启用扩展' })).toBeVisible()
  await expect(extensionsDialog(page).getByRole('button', { name: '打开 3D 空间' })).toHaveCount(0)

  // The choice survives a reload, and a disabled extension costs nothing.
  const requestsAfterDisable: string[] = []
  page.on('request', (request) => requestsAfterDisable.push(request.url()))
  await page.reload()
  await expect(page.locator('.world-canvas-host')).toBeVisible()
  await openExtensions(page)
  await expect(extensionsDialog(page).locator('.world-extensions-dialog__card')).toContainText('可选')

  expect(requestsAfterDisable.filter((url) => extensionAssets.includes(url)), '停用后不应再加载扩展代码').toEqual([])
  expect(requestsAfterDisable.filter((url) => SPATIAL_RUNTIME.test(url))).toEqual([])
})
