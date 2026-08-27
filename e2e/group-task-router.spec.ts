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
let runtime: GroupTaskRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-group-task-router-e2e-'))
  runtime = new GroupTaskRuntime()
  server = await createCyberServer({ stateRoot, workspacePath: process.cwd(), webRoot: join(process.cwd(), 'packages', 'web', 'dist'), port: 0, bootstrapDefaultWorld: true, runtime })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('routes task collaboration to matching roles while discussion keeps all rounds', async ({ page }) => {
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  await installFirecrawl(workspace.id, world.id)
  const employees = await recruitThree(world.id)
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('button', { name: '创建群聊' }).click()
  const dialog = page.getByRole('dialog', { name: '创建群聊' })
  await dialog.getByRole('radio', { name: '协作' }).check()
  for (const employee of employees) await dialog.locator('.group-member').filter({ hasText: employee.displayName }).getByRole('checkbox').check()
  await dialog.getByRole('textbox', { name: '群聊名称' }).fill('官网分析任务')
  await dialog.getByRole('button', { name: '创建群聊', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '协作', exact: true })).toBeVisible()

  const taskSession = current.store.listSessions(world.id).find((session) => session.title === '官网分析任务')
  expect(taskSession).toBeDefined()
  await page.getByRole('textbox', { name: '给当前世界的角色发送消息' }).fill('任务：查官网并做 HTML 分析页')
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(() => runtime.requests.length).toBeGreaterThanOrEqual(3)
  const executedEmployeeIds = new Set(runtime.requests.map((request) => request.agent.id))
  expect(executedEmployeeIds).toEqual(new Set([employees[0]!.id, employees[1]!.id]))
  expect(executedEmployeeIds).not.toContain(employees[2]!.id)
  expect(runtime.requests.every((request) => request.workTurnId !== undefined)).toBe(true)
  const canonicalPlan = await getJson<{ plan: { sessionId: string; workTurnId: string; steps: Array<{ assignedEmployeeIds: string[]; requiredSkills: string[]; status: string }> } }>(`${origin}/api/turns/${encodeURIComponent(runtime.requests[0]?.workTurnId ?? '')}/collaboration-plan`)
  const taskPlanResponse = await getJson<{ plan: { workTurnId: string; steps: Array<{ assignedEmployeeIds: string[]; requiredSkills: string[]; status: string }> } }>(`${origin}/api/sessions/${encodeURIComponent(canonicalPlan.plan.sessionId)}/task-plan`)
  const turn = await getJson<{ runs: Array<{ employeeId: string; turnId: string }> }>(`${origin}/api/turns/${encodeURIComponent(canonicalPlan.plan.workTurnId)}`)
  expect(canonicalPlan.plan.workTurnId).toBe(runtime.requests[0]?.workTurnId)
  expect(turn.runs.length).toBeGreaterThanOrEqual(3)
  expect(turn.runs.every((run) => run.turnId === canonicalPlan.plan.workTurnId)).toBe(true)
  expect(new Set(turn.runs.map((run) => run.employeeId))).toEqual(new Set([employees[0]!.id, employees[1]!.id]))
  expect(taskPlanResponse.plan.workTurnId).toBe(canonicalPlan.plan.workTurnId)
  expect(taskPlanResponse.plan.steps.flatMap((step) => step.assignedEmployeeIds)).toEqual(expect.arrayContaining([employees[0]!.id, employees[1]!.id]))
  expect(taskPlanResponse.plan.steps.flatMap((step) => step.assignedEmployeeIds)).not.toContain(employees[2]!.id)
  expect(taskPlanResponse.plan.steps.flatMap((step) => step.requiredSkills)).toEqual(expect.arrayContaining(['web.search.firecrawl', 'coding']))
  await expect(page.getByRole('region', { name: '当前世界多角色会话' })).toContainText('协作')
  const taskSummary = page.getByRole('region', { name: '当前世界多角色会话' }).locator('.task-collaboration-summary')
  await expect(taskSummary).toContainText('联网搜索')
  await expect(taskSummary).toContainText('软件实现')
  await expect(taskSummary).not.toContainText('web.search.firecrawl')
  expect(await page.locator('.message').evaluateAll((items) => items.some((item) => /tool-call|reasoning|调用工具|推理/.test(item.textContent ?? '')))).toBe(false)

  runtime.requests.length = 0
  const discussion = await postJson<{ session: { id: string } }>(`${origin}/api/worlds/${world.id}/group-sessions`, { title: '三人讨论', employeeIds: employees.map((employee) => employee.id), collaborationMode: 'discussion' })
  expect(discussion.status).toBe(201)
  const discussionChat = await postJson(`${origin}/api/worlds/${world.id}/chat`, { sessionId: discussion.body.session.id, employeeIds: employees.map((employee) => employee.id), interactionKind: 'meeting', collaborationMode: 'discussion', prompt: '讨论官网分析页的方向' })
  expect(discussionChat.status).toBe(200)
  await expect.poll(() => runtime.requests.length).toBe(3)
  expect(runtime.requests.map((request) => request.agent.id)).toEqual(expect.arrayContaining(employees.map((employee) => employee.id)))

  const screenshotRoot = join(process.cwd(), 'artifacts', 'group-task-router')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1_440, height: 900, label: '1440x900' }, { width: 1_920, height: 1_080, label: '1920x1080' }, { width: 3_840, height: 2_160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    const region = page.getByRole('region', { name: '当前世界多角色会话' })
    const layout = await region.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const offenders = [...element.querySelectorAll<HTMLElement>('*')]
        .filter((child) => child.getBoundingClientRect().right > bounds.right + 1)
        .slice(0, 8)
        .map((child) => ({ className: child.className, right: Math.round(child.getBoundingClientRect().right), width: Math.round(child.getBoundingClientRect().width) }))
      return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, offenders }
    })
    expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth + 1)
    await page.screenshot({ path: join(screenshotRoot, `group-task-${viewport.label}.png`) })
  }
  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function recruitThree(worldId: string): Promise<EmployeeInstance[]> {
  const definitions = [
    ['cyber-company.web-researcher', '网络研究员', ['knowledge-retrieval', 'evidence-summarization', 'scientific-reasoning', 'web.search.firecrawl']],
    ['cyber-company.software-engineer', '软件实现员', ['coding', 'testing']],
    ['cyber-company.secretary', '叙事角色', ['storytelling']],
  ] as const
  const result: EmployeeInstance[] = []
  for (const [blueprintId, displayName, skillGrants] of definitions) {
    const response = await postJson<{ employee: EmployeeInstance }>(`${origin}/api/worlds/${worldId}/recruit`, { blueprintId, blueprintVersion: 1, displayName, skillGrants })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    result.push(response.body.employee)
  }
  return result
}

async function installFirecrawl(workspaceId: string, worldId: string): Promise<void> {
  const market = await getJson<{ items: Array<{ manifest: { id: string; version: string } }> }>(`${origin}/api/marketplace?market=plugin`)
  const item = market.items.find((candidate) => candidate.manifest.id === 'official-firecrawl-search')
  if (item === undefined) throw new Error('official-firecrawl-search package is missing from the local marketplace')
  const preview = await postJson<{ preview: { approvalToken: string } }>(`${origin}/api/workspaces/${workspaceId}/marketplace/preview`, { packageId: item.manifest.id, version: item.manifest.version })
  expect(preview.status).toBe(200)
  const install = await postJson(`${origin}/api/workspaces/${workspaceId}/marketplace/install`, { packageId: item.manifest.id, version: item.manifest.version, approvalToken: preview.body.preview.approvalToken, worldId })
  expect(install.status, JSON.stringify(install.body)).toBe(201)
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body = await response.json() as unknown
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`)
  return body as T
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('群聊任务路由 E2E 服务尚未启动')
  return server
}

class GroupTaskRuntime implements AgentRuntimePort {
  requests: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: `${request.agent.displayName}已完成最终回复。`, eventCount: 0 }
  }

  async close(): Promise<void> {}
}
