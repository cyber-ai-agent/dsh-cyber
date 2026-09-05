import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest, EmployeeInstance } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
let runtime: WorkSystemRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-work-system-e2e-'))
  runtime = new WorkSystemRuntime()
  server = await createCyberServer({ stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages', 'web', 'dist'), port: 0, bootstrapDefaultWorld: true, runtime })
  origin = (await server.start()).origin
})
test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }) })

test('runs the task, immutable deliverable review, change request, and accepted replacement flow', async ({ page }) => {
  const current = server!
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const coordinator = current.store.listEmployees(world.id)[0]!
  const engineer = await recruit(world.id)
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)

  await page.goto(origin)
  await openTasks(page)
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByLabel('任务标题').fill('工作系统浏览器验收')
  await page.getByLabel('任务目标').fill('实现、验证并交付一个可恢复的真实任务闭环。')
  await page.getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作系统浏览器验收' })).toBeVisible()
  await page.getByRole('button', { name: '生成计划并执行' }).click()
  await expect(page.locator('.task-status')).toHaveText('等待验收', { timeout: 15_000 })
  await expect(page.getByText('计划 v1')).toBeVisible()
  await page.locator('details.dock-detail-fold > summary').filter({ hasText: '执行与证据' }).click()
  await expect(page.getByText(/选择原因/).first()).toBeVisible()

  const task = current.work.list(world.id)[0]!
  let detail = current.work.detail(task.id)
  const filesPath = join(stateRoot, 'worlds', world.id, 'files')
  await mkdir(filesPath, { recursive: true })
  await writeFile(join(filesPath, 'work-delivery.md'), '# 第一版\n', 'utf8')
  const artifactV1 = await current.artifacts.publishFromWorkspace({ workspaceId: workspace.id, worldId: world.id, sourceRelativePath: 'work-delivery.md', title: '工作交付', kind: 'markdown', createdByKind: 'employee', createdById: engineer.id, employeeId: engineer.id, workTurnId: detail.runs[0]!.workTurnId, agentRunId: detail.runs[0]!.agentRunIds[0], idempotencyKey: 'e2e-work-v1' })
  await page.reload(); await openTasks(page)
  await page.getByLabel('提交角色').selectOption(engineer.id)
  await page.getByLabel('交付摘要').fill('第一版交付，等待验收。')
  await page.getByRole('button', { name: '提交验收' }).click()
  await page.getByLabel('验收反馈').fill('请补充恢复验证并提交新版本。')
  await page.getByRole('button', { name: '要求修改' }).click()
  await expect(page.getByText('要求修改', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '生成新版本' }).click()
  await expect(page.locator('.task-status')).toHaveText('等待验收', { timeout: 15_000 })
  expect(runtime.requests.some((request) => request.prompt.includes('补充恢复验证'))).toBe(true)

  detail = current.work.detail(task.id)
  await writeFile(join(filesPath, 'work-delivery.md'), '# 第二版\n\n已补充恢复验证。\n', 'utf8')
  await current.artifacts.createVersion({ workspaceId: workspace.id, worldId: world.id, sourceRelativePath: 'work-delivery.md', artifactId: artifactV1.artifact.id, title: '工作交付', kind: 'markdown', createdByKind: 'employee', createdById: engineer.id, employeeId: engineer.id, workTurnId: detail.runs[1]!.workTurnId, agentRunId: detail.runs[1]!.agentRunIds[0], idempotencyKey: 'e2e-work-v2' })
  await page.reload(); await openTasks(page)
  await page.getByLabel('提交角色').selectOption(engineer.id)
  await page.getByLabel('交付摘要').fill('第二版已完成恢复验证。')
  await page.getByRole('button', { name: '提交验收' }).click()
  await page.getByRole('button', { name: '接受' }).click()
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('v2 · 工作交付')).toBeVisible()

  const screenshotRoot = join(process.cwd(), 'artifacts', 'core-work-system')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    const panel = page.getByRole('region', { name: '任务工作台' })
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `work-system-${viewport.label}.png`) })
  }
  expect(issues, issues.join('\n')).toEqual([])
})

async function openTasks(page: import('@playwright/test').Page) {
  const taskTab = page.getByRole('tab', { name: '任务' })
  if (await taskTab.count() === 0) { await page.getByRole('button', { name: '更多' }).click(); await page.getByRole('menuitemcheckbox', { name: '任务' }).click() }
  else await taskTab.click()
  await expect(page.getByRole('region', { name: '任务工作台' })).toBeVisible()
}
async function recruit(worldId: string): Promise<EmployeeInstance> {
  const response = await fetch(`${origin}/api/worlds/${worldId}/recruit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blueprintId: 'cyber-company.software-engineer', blueprintVersion: 1, displayName: '交付工程师', skillGrants: ['coding', 'testing'] }) })
  const body = await response.json() as { employee: EmployeeInstance }
  expect(response.status).toBe(201)
  return body.employee
}
class WorkSystemRuntime implements AgentRuntimePort { requests: AgentTurnRequest[] = []; async runTurn(request: AgentTurnRequest) { this.requests.push(request); return { agentSessionId: `e2e-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已完成。`, eventCount: 0 } } async close() {} }
