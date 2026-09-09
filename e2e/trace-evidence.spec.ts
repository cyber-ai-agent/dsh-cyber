import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { normalizeHarnessTraceNotification } from '../packages/harness-adapter/lib/adapter.js'
import { ToolTraceSubjects } from '../packages/harness-adapter/lib/tool-result-summary.js'
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
    const resultLines = [
      'export const directoryEnabled = true;',
      'access_token="LOCAL-FIXTURE-SECRET"',
      ...Array.from({ length: 6 }, (_, index) => `body-${index + 1}`),
    ]
    notify('tool/result', { message: { source: { callId: 'fixture-read' }, content: [{ type: 'tool-result', toolCallId: 'fixture-read', content: [{ type: 'text', text: resultLines.join('\n') }] }] } })
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

test('expands and reads raw event evidence, survives reload, and fits three viewports', async ({ page }, info) => {
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
  const openTraceTab = async () => {
    // This is a permanent tab, never a More-menu item. count() during reload
    // observes an unmounted shell and would incorrectly enter the More menu.
    const tab = dock.getByRole('tab', { name: '轨迹', exact: true })
    await expect(tab).toBeVisible()
    await tab.click()
  }
  await openTraceTab()
  let entry = await openTraceEntry(dock, '完成处理')
  // The redundant target command line is gone; one merged evidence box holds
  // the raw command and the raw result together.
  await expect(entry.locator('.world-trace-tool__target')).toHaveCount(0)
  let box = entry.locator('.world-trace-tool__evidence')
  await expect(box).toHaveCount(1)
  // Collapsed: a five-line preview, raw and unmasked, with an expand affordance.
  await expect(box).toHaveClass(/is-clickable/)
  const preview = box.locator('pre')
  await expect(preview).toContainText('character-profile-runtime.ts')
  await expect(preview).toContainText('LOCAL-FIXTURE-SECRET')
  await expect(preview).not.toContainText('body-6')
  // The copy affordances are gone: select text in the box instead.
  await expect(entry.getByRole('button', { name: /复制/ })).toHaveCount(0)
  // Clicking the box expands the full raw command and result.
  await preview.click()
  await expect(box).toHaveText(/命令/)
  await expect(box).toHaveText(/结果/)
  await expect(box.locator('.world-trace-tool__part pre').last()).toContainText('body-6')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    await expect(box).toBeVisible()
    const overflow = await entry.locator('.world-trace-tool__body').evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(overflow).toBe(false)
    await page.screenshot({ path: info.outputPath(`trace-${size.width}x${size.height}.png`) })
  }
  await page.reload()
  await openTraceTab()
  entry = await openTraceEntry(dock, '完成处理')
  // Persisted evidence reloads collapsed again; expand to the full raw text.
  box = entry.locator('.world-trace-tool__evidence')
  await expect(box).toHaveClass(/is-clickable/)
  await expect(box.locator('pre')).toContainText('LOCAL-FIXTURE-SECRET')
  await box.locator('pre').click()
  await expect(box.locator('.world-trace-tool__part pre').last()).toContainText('body-6')
  await writeFile(info.outputPath('console.json'), JSON.stringify(consoleIssues, null, 2))
  expect(consoleIssues).toEqual([])
})
