import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let stateRoot = ''; let origin = ''; let port = 0; let calls = 0
let release: () => void = () => {}
const gate = new Promise<void>((resolve) => { release = resolve })
const previousCatalog = process.env.DSH_CYBER_MODEL_CATALOG_URL
const image = () => readFile(join(process.cwd(), 'packages/web/public/assets/cyber-office-world-clean.png'))
const runtime = {
  async runTurn(request: AgentTurnRequest) {
    calls++
    await gate
    // Deterministic bytes use actual host publication and SQLite provenance,
    // not a cloud image model or a fabricated browser response.
    await server!.artifacts.publishGeneratedImage({
      workspaceId: request.agent.workspaceId, worldId: request.agent.worldId,
      bytes: await image(), mimeType: 'image/png', title: '已保存的测试图片', createdById: request.agent.id,
      sessionId: request.conversationId, workTurnId: request.workTurnId!, agentRunId: request.agentRunId!,
    })
    return { agentSessionId: 'source-task-fixture', finalResponse: '图片已经保存，请核对已有成果。', eventCount: 0 }
  },
  async close() { release() },
}
const options = () => ({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages/web/dist'), port, bootstrapDefaultWorld: true, runtime,
  conversationTaskIntent: { async classify() { return { title: '检查已保存图片的任务状态', description: '核对来源对话的图片，确认后结束任务，不重复生成。', priority: 'normal' as const } } },
})
test.beforeAll(async () => {
  process.env.DSH_CYBER_MODEL_CATALOG_URL = ''
  stateRoot = await mkdtemp(join(tmpdir(), 'source-task-browser-'))
  server = await createCyberServer(options()); const address = await server.start(); origin = address.origin; port = address.port
})
test.afterAll(async () => { release(); await server?.close(); if (stateRoot) await rm(stateRoot, { recursive: true, force: true }); if (previousCatalog === undefined) delete process.env.DSH_CYBER_MODEL_CATALOG_URL; else process.env.DSH_CYBER_MODEL_CATALOG_URL = previousCatalog })
async function openTasks(page: Page) {
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const tab = page.getByRole('tab', { name: '任务', exact: true })
  if (await tab.count() === 0) { await page.getByRole('button', { name: '更多', exact: true }).click(); await page.getByRole('menuitemcheckbox', { name: '任务', exact: true }).click() }
  else await tab.click()
  return page.getByRole('region', { name: '任务工作台' })
}
async function restart(page: Page) {
  await page.goto('about:blank')
  await server!.close(); server = undefined
  server = await createCyberServer(options()); await server.start()
  await page.goto(origin); return openTasks(page)
}

test('follows source completion live, shows saved results, and confirms once without another model run', async ({ page }, info) => {
  test.setTimeout(75_000)
  const issues: string[] = []; attachAppConsoleRecorder(page, issues)
  const workspace = server!.store.listWorkspaces()[0]!
  const world = server!.store.listWorlds(workspace.id)[0]!
  const employee = server!.store.listEmployees(world.id)[0]!
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(origin)
  const panel = await openTasks(page)
  const response = await page.request.post(`${origin}/api/worlds/${world.id}/chat`, { data: { employeeIds: [employee.id], prompt: '请生成图片并保存', queueMode: 'normal' } })
  expect(response.status()).toBe(202)
  await expect.poll(() => server!.work.list(world.id)[0]?.status).toBe('running')
  const taskId = server!.work.list(world.id)[0]!.id
  await expect(panel.locator('.task-source')).toContainText('来源对话正在处理')
  await expect(panel.getByRole('button', { name: '确认完成', exact: true })).toHaveCount(0)
  release()
  await expect(panel.locator('.task-source')).toContainText('对话执行已结束', { timeout: 15_000 })
  await expect(panel.locator('.task-detail .task-status')).not.toHaveText('进行中')
  const preview = panel.getByRole('img', { name: '已保存的测试图片' })
  await expect(preview).toBeVisible(); await expect.poll(() => preview.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true)
  await panel.locator('.task-source-result summary').click()
  await expect(panel.locator('.task-source-result pre')).toContainText('图片已经保存')
  await page.screenshot({ path: info.outputPath('source-completion-ready.png') })
  const count = calls
  await panel.getByRole('button', { name: '确认完成', exact: true }).click()
  await expect(panel.locator('.task-source h3')).toHaveText('已确认完成')
  await expect(panel.locator('.task-detail .task-status')).toHaveText('已完成')
  expect(calls).toBe(count)
  expect(server!.work.detail(taskId).runs).toEqual([])
  expect(server!.work.detail(taskId).deliverables).toEqual([])
  await expect(panel.locator('.task-source-retry')).toHaveCount(0)
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: info.outputPath(`source-completion-${size.width}x${size.height}.png`) })
  }
  await page.reload(); await openTasks(page)
  await expect(panel.locator('.task-source h3')).toHaveText('已确认完成')
  await restart(page)
  await expect(panel.locator('.task-source h3')).toHaveText('已确认完成')
  expect(server!.work.detail(taskId).task.status).toBe('completed'); expect(calls).toBe(count)
  await writeFile(info.outputPath('console.json'), JSON.stringify(issues, null, 2)); expect(issues).toEqual([])
})

test('recovers an interrupted source with existing output and records the owner decision without re-execution', async ({ page }, info) => {
  test.setTimeout(60_000)
  const issues: string[] = []; attachAppConsoleRecorder(page, issues)
  const workspace = server!.store.listWorkspaces()[0]!; const world = server!.store.listWorlds(workspace.id)[0]!; const employee = server!.store.listEmployees(world.id)[0]!
  const session = server!.store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '重启前的来源', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }] })
  const turn = server!.store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
  server!.store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '检查已生成的图片', metadata: { workTurnId: turn.id } })
  server!.store.startWorkTurn(turn.id)
  const task = server!.work.createFromSource({ worldId: world.id, workTurnId: turn.id, title: '重启前已保存图片', description: '来源回合未正常结束，但实际产物已经保存。' }).task
  await server!.artifacts.publishGeneratedImage({ workspaceId: workspace.id, worldId: world.id, bytes: await image(), mimeType: 'image/png', title: '重启前的测试图片', createdById: employee.id, sessionId: session.id, workTurnId: turn.id })
  const panel = await restart(page)
  await panel.locator('.task-board').getByRole('button', { name: /重启前已保存图片/ }).click()
  await expect(panel.locator('.task-source')).toContainText('服务重启时')
  const complete = panel.getByRole('button', { name: '确认完成', exact: true }); await expect(complete).toBeDisabled()
  await panel.getByRole('textbox', { name: '完成说明' }).fill('已核对保存的图片，任务目标已达成。')
  const count = calls; await complete.click()
  await expect(panel.locator('.task-source h3')).toHaveText('已确认完成')
  expect(server!.work.detail(task.id).sourceTurn?.status).toBe('interrupted')
  expect(calls).toBe(count)
  expect(server!.work.detail(task.id).growthEvidence).toEqual([])
  await page.screenshot({ path: info.outputPath('source-completion-interrupted-confirmed.png') })
  await writeFile(info.outputPath('console.json'), JSON.stringify(issues, null, 2)); expect(issues).toEqual([])
})
