import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { createCyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

test('lists every built-in template and creates a selected world without package installation', async ({ page }, testInfo) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-market-builtins-'))
  const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'),
    bootstrapDefaultWorld: true, port: 0, runtime: { async runTurn() { throw new Error('No model run expected') }, async close() {} } })
  const { origin } = await server.start()
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  try {
    const catalog = await (await fetch(`${origin}/api/catalog/world-templates`)).json() as { items: Array<{ id: string; displayName: string }> }
    await page.goto(origin)
    await page.getByRole('button', { name: '市场', exact: true }).click()
    const builtin = page.getByRole('region', { name: '内置世界模板' })
    for (const template of catalog.items) await expect(builtin.getByRole('button', { name: `选择${template.displayName}`, exact: true })).toBeVisible()
    for (const [width, height] of [[1440, 900], [1920, 1080], [3840, 2160]] as const) {
      await page.setViewportSize({ width, height })
      await page.screenshot({ path: testInfo.outputPath(`market-${width}x${height}.png`) })
    }
    const workspace = server.store.listWorkspaces()[0]!
    const installedCount = server.store.listInstalledPackages(workspace.id).length
    await builtin.getByRole('button', { name: '选择AI 学院', exact: true }).click()
    await builtin.getByRole('textbox', { name: '新世界名称' }).fill('我的学习世界')
    await builtin.getByRole('button', { name: '创建并进入', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '扩展市场' })).toBeHidden()
    await expect(page.locator('.topbar-world-switcher summary')).toContainText('我的学习世界')
    expect(server.store.listWorlds(workspace.id).find((world) => world.name === '我的学习世界')?.templateId).toBe('ai-academy')
    expect(server.store.listInstalledPackages(workspace.id)).toHaveLength(installedCount)
    expect(issues).toEqual([])
  } finally {
    await page.close()
    await server.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
