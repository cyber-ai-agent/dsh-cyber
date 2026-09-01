import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer
let origin = ''
let stateRoot = ''

const quietRuntime: AgentRuntimePort = {
  async runTurn(request) {
    return { agentSessionId: request.agent.agentSessionId ?? `lifecycle-${request.agent.id}`, finalResponse: 'ok', eventCount: 0 }
  },
  async close() {},
}

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-world-lifecycle-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: quietRuntime,
  })
  const workspaceId = server.store.listWorkspaces()[0]!.id
  server.store.createWorld({ workspaceId, name: '待归档的旧世界', templateId: 'personal-world' })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('archiving a world removes it from the default list and restoring brings it back', async ({ page }) => {
  await page.goto(origin)

  const switcher = page.locator('.topbar-world-switcher > summary')
  const switcherEntries = page.locator('.topbar-world-switcher__menu [role="menuitemradio"]')
  await switcher.click()
  await expect(switcherEntries.filter({ hasText: '待归档的旧世界' })).toHaveCount(1)

  await page.getByRole('button', { name: /^管理世界/ }).click()
  const library = page.getByRole('dialog', { name: '世界库' })
  const row = library.locator('.world-library-item').filter({ hasText: '待归档的旧世界' })
  await expect(row).toHaveCount(1)

  // Archive: the world leaves the default list, both in the library and in the
  // shell's own world list, and nothing about it is destroyed.
  await row.getByRole('button', { name: '归档' }).click()
  await expect(library.getByText('「待归档的旧世界」已归档，不再出现在世界列表里。')).toBeVisible()
  await expect(library.locator('.world-library-item').filter({ hasText: '待归档的旧世界' })).toHaveCount(0)
  expect(server.store.listWorlds(server.store.listWorkspaces()[0]!.id).map((world) => world.name)).not.toContain('待归档的旧世界')

  await library.getByRole('tab', { name: '归档世界' }).click()
  const archivedRow = library.locator('.world-library-item').filter({ hasText: '待归档的旧世界' })
  await expect(archivedRow).toHaveCount(1)

  await archivedRow.getByRole('button', { name: '恢复' }).click()
  await expect(library.getByText('「待归档的旧世界」已恢复。')).toBeVisible()
  await expect(library.locator('.world-library-item').filter({ hasText: '待归档的旧世界' })).toHaveCount(0)

  await library.getByRole('tab', { name: '我的世界' }).click()
  await expect(library.locator('.world-library-item').filter({ hasText: '待归档的旧世界' })).toHaveCount(1)

  // No horizontal overflow at any of the supported desktop widths.
  for (const viewport of [{ width: 1_440, height: 900 }, { width: 1_920, height: 1_080 }, { width: 3_840, height: 2_160 }]) {
    await page.setViewportSize(viewport)
    expect(await library.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  }
  await page.setViewportSize({ width: 1_584, height: 992 })

  await library.getByRole('button', { name: '关闭世界库' }).click()
  await expect(library).toBeHidden()
  // Closing hands focus back to the control that opened the library.
  await expect(switcher).toBeFocused()

  await switcher.click()
  await expect(switcherEntries.filter({ hasText: '待归档的旧世界' })).toHaveCount(1)
})
