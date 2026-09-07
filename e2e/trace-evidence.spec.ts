import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { normalizeHarnessTraceNotification } from '../packages/harness-adapter/lib/adapter.js'
import { ToolTraceSubjects } from '../packages/harness-adapter/lib/tool-result-summary.js'
import { openDockTab } from './dock-test-helpers.js'
import { openTraceEntry } from './trace-test-helpers.js'

let server: CyberServer
let stateRoot: string
let origin: string
class EvidenceRuntime {
  async runTurn(request: AgentTurnRequest) {
    const subjects = new ToolTraceSubjects()
    const notify = (type: string, data: object) => {
      const notification = { method: 'session.event', params: { sessionId: request.conversationId, event: { type, data, time: Date.now() } } } as Parameters<typeof normalizeHarnessTraceNotification>[0]
      for (const event of normalizeHarnessTraceNotification(notification, subjects)) request.onEvent?.(event)
    }
    notify('tool/call', { name: 'read', callId: 'fixture-read', arguments: JSON.stringify({ file_path: 'packages/server/src/services/character-profile-runtime.ts' }) })
    notify('tool/result', { message: { source: { callId: 'fixture-read' }, content: [{ type: 'tool-result', toolCallId: 'fixture-read', content: [{ type: 'text', text: 'export const directoryEnabled = true;\naccess_token="LOCAL-FIXTURE-SECRET"' }] }] } })
    return { agentSessionId: 'evidence-runtime', finalResponse: '已完成轨迹样例。', eventCount: 2 }
  }
  async close() {}
}
test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'cyber-evidence-browser-'))
  server = await createCyberServer({ stateRoot, workspacePath: process.cwd(), webRoot: join(process.cwd(), 'packages/web/dist'), port: 0, runtime: new EvidenceRuntime() })
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server.close(); await rm(stateRoot, { recursive: true, force: true }) })

test('expands and copies sanitized real-event evidence, survives reload, and fits three viewports', async ({ page }, info) => {
  const consoleIssues: string[] = []
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(message.text()) })
  page.on('pageerror', (error) => consoleIssues.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  await page.getByRole('button', { name: '创建我的世界' }).click()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.fill('显示读取文件的轨迹')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('已完成轨迹样例。', { exact: true })).toBeVisible()
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '轨迹')
  let entry = await openTraceEntry(dock, '完成处理')
  const target = 'packages/server/src/services/character-profile-runtime.ts'
  await expect(entry.locator('.world-trace-tool__target')).toHaveText(target)
  await expect(entry.getByText('查看参数', { exact: true })).toHaveCount(0)
  await entry.locator('.world-trace-tool__evidence > summary').click()
  await expect(entry.locator('pre')).toContainText('directoryEnabled = true')
  await expect(entry.locator('pre')).not.toContainText('LOCAL-FIXTURE-SECRET')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await entry.getByRole('button', { name: '复制结果', exact: true }).click()
  await expect(entry.getByRole('status')).toHaveText('已复制')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toContain('directoryEnabled')
  expect(copied).not.toContain('LOCAL-FIXTURE-SECRET')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    await expect(entry.locator('pre')).toBeVisible()
    const overflow = await entry.locator('.world-trace-tool__body').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(overflow).toBe(false)
    await page.screenshot({ path: info.outputPath(`trace-${size.width}x${size.height}.png`) })
  }
  await page.reload()
  await openDockTab(dock, '轨迹')
  entry = await openTraceEntry(dock, '完成处理')
  await entry.locator('.world-trace-tool__evidence > summary').click()
  await expect(entry.locator('pre')).toContainText('directoryEnabled')
  await expect(entry.locator('pre')).not.toContainText('LOCAL-FIXTURE-SECRET')
  await writeFile(info.outputPath('console.json'), JSON.stringify(consoleIssues, null, 2))
  expect(consoleIssues).toEqual([])
})
