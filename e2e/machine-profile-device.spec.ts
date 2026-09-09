import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { auditVisuals } from './visual-audit-helpers.js'

/**
 * A device's machine profile lives in the connection hub, next to the
 * connection it describes, and never in the conversation sidebar. The device
 * is seeded through the real API; the profile itself is only probed on the
 * owner's explicit request, so this spec asserts the read path and the block's
 * placement, not a live SSH round trip.
 */
let server: CyberServer
let origin = ''
let stateRoot = ''
let workspaceId = ''
let connectionId = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-machine-profile-device-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages/web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
  })
  origin = (await server.start()).origin
  workspaceId = server.store.listWorkspaces()[0]!.id

  // A multi-connection provider creates a fresh row on a PUT without a
  // connectionId; the server owns the id, exactly like the hub UI does it.
  const response = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/builtin.ssh-device`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'E2E 生产机',
        enabled: true,
        config: { displayName: 'E2E 生产机', host: '10.0.0.99', port: 22, username: 'root' },
        secrets: { password: 'e2e-only-password' },
      }),
    },
  )
  const body = await response.text()
  expect(response.status, body).toBe(200)
  connectionId = (JSON.parse(body) as { connection: { id: string } }).connection.id
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('shows the device profile block in the connection hub, and never in the sidebar', async ({ page }, testInfo) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()

  // The block belongs to the connection it describes, not to the sidebar.
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await expect(dock.getByRole('button', { name: '机器档案' })).toHaveCount(0)

  await page.getByRole('button', { name: '连接中心', exact: true }).click()
  const hub = page.getByRole('dialog', { name: '连接中心' })
  await expect(hub).toBeVisible()
  await hub.getByRole('button', { name: /SSH 设备/ }).click()
  await hub.getByRole('button', { name: /E2E 生产机/ }).click()

  const panel = hub.locator('.machine-profile')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('宿主探测的本机事实')
  // Never probed: the block says so and offers the one action that can fix it.
  await expect(panel).toContainText('还没有生成机器档案')
  await expect(panel.getByRole('button', { name: '刷新档案' })).toBeEnabled()
  // A device profile is probed over SSH, not edited locally.
  await expect(panel.locator('form')).toHaveCount(0)
  await expect(panel).not.toContainText('自定义命令行工具')

  // Reading is free: the profile really is absent until someone probes.
  const stored = await fetch(
    `${origin}/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/builtin.ssh-device/connections/${encodeURIComponent(connectionId)}/environment`,
  )
  expect(stored.status).toBe(200)
  expect((await stored.json() as { profile: unknown }).profile).toBeNull()

  for (const [width, height] of [[1440, 900], [1920, 1080], [3840, 2160]] as const) {
    await page.setViewportSize({ width, height })
    await expect(panel).toBeVisible()
    const box = await panel.boundingBox()
    expect(box, `${width}x${height} bounding box`).not.toBeNull()
    expect(box!.x, `${width}x${height} left edge`).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width, `${width}x${height} right edge`).toBeLessThanOrEqual(width + 1)
    const audit = await auditVisuals(panel)
    expect(audit.overflow, `${width}x${height} horizontal overflow`).toBeLessThanOrEqual(1)
    expect(audit.minFontSize, `${width}x${height} smallest font`).toBeGreaterThanOrEqual(12)
    expect(audit.minOpacity, `${width}x${height} parent dimming`).toBeGreaterThanOrEqual(0.99)
    expect(audit.minContrast, `${width}x${height} contrast`).toBeGreaterThanOrEqual(4.5)
    await page.screenshot({ path: testInfo.outputPath(`machine-profile-device-${width}x${height}.png`) })
  }

  expect(issues, issues.join('\n')).toEqual([])
})
