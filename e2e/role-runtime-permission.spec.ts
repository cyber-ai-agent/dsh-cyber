import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'

let server: CyberServer
let origin = ''
let stateRoot = ''
let runtime: PermissionRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-role-runtime-permission-e2e-'))
  runtime = new PermissionRuntime()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('uses the recruited role default, persists full access, and exposes no administrator UI', async ({ page }, testInfo) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.getByText('世界管理员')).toHaveCount(0)

  await page.getByRole('button', { name: '世界管理' }).click()
  const worldSettings = page.getByRole('dialog', { name: /世界管理|世界设置/ })
  await expect(worldSettings).not.toContainText('管理员')
  await worldSettings.getByRole('button', { name: '取消' }).click()

  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await dock.getByRole('button', { name: '新增角色', exact: true }).click()
  const recruitment = page.getByRole('dialog', { name: '新增角色' })
  await recruitment.getByRole('button', { name: /开发工程师 v1/ }).click()
  await recruitment.getByLabel('角色名字（可选）').fill('默认权限工程师')
  await recruitment.getByRole('radio', { name: /当前世界/ }).check()
  await recruitment.getByRole('button', { name: /确认新增|再创建一名/ }).click()
  await expect(recruitment).toBeHidden()

  const world = server.store.listWorlds(server.store.listWorkspaces()[0]!.id)[0]!
  const employee = server.store.listEmployees(world.id).find((item) => item.displayName === '默认权限工程师')!
  expect(server.store.getEmployeeRevision(employee.id, employee.currentRevision)?.runtimePermissionMode).toBe('workspace-write')

  await expect(page.getByRole('button', { name: '与默认权限工程师私聊' })).toBeVisible()
  await page.getByRole('button', { name: '与默认权限工程师私聊' }).click()
  await expect(page.getByRole('button', { name: '当前消息权限' })).toContainText('当前世界')
  const composer = page.getByRole('textbox', { name: /给当前世界的.+发送消息/ })
  await composer.fill('验证角色默认权限')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => runtime.requests.at(-1)?.permissionMode).toBe('workspace-write')

  await openDockTab(dock, '角色')
  await dock.getByRole('button', { name: '管理默认权限工程师' }).click()
  let settings = page.getByRole('dialog', { name: /角色设置 · 默认权限工程师/ })
  await settings.getByRole('tab', { name: '对话权限' }).click()
  await settings.getByRole('radio', { name: /完全访问/ }).check()
  await settings.getByRole('checkbox', { name: /我确认允许这个角色默认完全访问/ }).check()
  await settings.getByRole('button', { name: '保存对话权限' }).click()
  await expect(settings).toBeHidden()

  await page.reload()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('button', { name: '与默认权限工程师私聊' }).click()
  await expect(page.getByRole('button', { name: '当前消息权限' })).toContainText('完全访问')
  await composer.fill('验证持久完全访问')
  const requestPromise = page.waitForRequest((request) => request.url().endsWith(`/api/worlds/${world.id}/chat`) && request.method() === 'POST')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const body = (await requestPromise).postDataJSON() as Record<string, unknown>
  expect(body).toMatchObject({ permissionMode: 'danger-full-access', runtimeAccessGrantId: expect.any(String) })
  await expect.poll(() => runtime.requests.at(-1)?.permissionMode).toBe('danger-full-access')

  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '角色')
  await page.getByRole('region', { name: '世界与角色侧边栏' }).getByRole('button', { name: '管理默认权限工程师' }).click()
  settings = page.getByRole('dialog', { name: /角色设置 · 默认权限工程师/ })
  await settings.getByRole('tab', { name: '对话权限' }).click()
  await settings.locator('input[type="radio"][value="read-only"]').check()
  await settings.getByRole('button', { name: '保存对话权限' }).click()
  await expect(settings).toBeHidden()
  expect(server.store.listOwnerRuntimeAccessGrants(world.id)).toEqual([])

  await page.reload()
  await page.getByRole('button', { name: '与默认权限工程师私聊' }).click()
  await expect(page.getByRole('button', { name: '当前消息权限' })).toContainText('只读访问')
  for (const [width, height] of [[1440, 900], [1920, 1080], [3840, 2160]] as const) {
    await page.setViewportSize({ width, height })
    await page.getByRole('button', { name: '当前消息权限' }).click()
    const menu = page.getByRole('menu', { name: '当前消息权限' })
    await expect(menu.getByRole('menuitemradio', { name: /^只读访问/ })).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /^当前世界/ })).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: /^完全访问/ })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`permissions-${width}x${height}.png`) })
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    if (width === 1920) await page.screenshot({ path: testInfo.outputPath('workspace-1920x1080.png') })
  }
  expect(issues, issues.join('\n')).toEqual([])
})

class PermissionRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return {
      agentSessionId: request.agent.agentSessionId ?? `permission-${request.agent.id}`,
      finalResponse: '权限验证完成。',
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}
