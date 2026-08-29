import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
let worldId = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-scene-skin-decoupling-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
  })
  const workspaceId = server.store.listWorkspaces()[0]!.id
  worldId = server.store.listWorlds(workspaceId)[0]!.id
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('switching conversation Skin keeps the live World mounted and its manifest unchanged', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)

  await page.addInitScript(() => {
    window.localStorage.setItem('dsh_custom_themes', JSON.stringify([{
      id: 'e2e-chat-skin',
      displayName: 'E2E 会话皮肤',
      description: '只改变聊天与界面，不拥有 World Scene。',
      author: 'E2E',
      source: 'custom',
      tokens: {
        accentColor: '#6d5dfc',
        pageBackground: '#101018',
        panelBackground: '#171724',
        ownerBubbleColor: '#2d2852',
        characterBubbleColor: '#1d1b31',
        backdropImage: '/assets/cyber-office-world.webp',
        backdropOpacity: 0.72,
      },
    }]))
  })

  await page.goto(origin)

  const runtimeDock = page.locator('.world-runtime-dock')
  await expect(runtimeDock).toBeVisible()
  const originalRuntime = await runtimeDock.elementHandle()
  expect(originalRuntime).not.toBeNull()

  const beforeResponse = await page.request.get(`${origin}/api/worlds/${encodeURIComponent(worldId)}/theme-manifest`)
  expect(beforeResponse.ok()).toBe(true)
  const beforeManifest = await beforeResponse.json()

  await page.getByRole('button', { name: /皮肤:/ }).click()
  const skinMenu = page.getByRole('menu', { name: '界面与会话皮肤列表' })
  await expect(skinMenu).toBeVisible()
  await skinMenu.getByRole('menuitemradio').filter({ hasText: 'E2E 会话皮肤' }).click()

  await expect(page.locator('html')).toHaveAttribute('data-skin', 'e2e-chat-skin')
  expect(await originalRuntime!.evaluate((element) => element.isConnected)).toBe(true)
  await expect(runtimeDock).toBeVisible()

  const afterResponse = await page.request.get(`${origin}/api/worlds/${encodeURIComponent(worldId)}/theme-manifest`)
  expect(afterResponse.ok()).toBe(true)
  expect(await afterResponse.json()).toEqual(beforeManifest)

  await page.getByRole('button', { name: '世界场景' }).click()
  const sceneDialog = page.getByRole('dialog', { name: /世界场景/ })
  await expect(sceneDialog).toBeVisible()
  await expect(sceneDialog.getByText('独立于 Skin')).toBeVisible()
  await sceneDialog.getByRole('button', { name: '关闭世界场景' }).click()

  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})
