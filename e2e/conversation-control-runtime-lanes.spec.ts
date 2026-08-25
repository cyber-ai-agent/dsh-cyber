import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest, EmployeeInstance } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
let runtime: LaneRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-conversation-control-e2e-'))
  runtime = new LaneRuntime()
  server = await createCyberServer({ stateRoot, workspacePath: process.cwd(), webRoot: join(process.cwd(), 'packages', 'web', 'dist'), port: 0, bootstrapDefaultWorld: true, runtime })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('keeps durable queue controls, reload state and stop facts visible across runtime lanes', async ({ page }) => {
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const employee = current.store.listEmployees(world.id)[0]!
  const second = await recruit(world.id)
  const consoleIssues: string[] = []
  recordConsole(page, consoleIssues)

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const first = await postJson<{ session: { id: string } }>(`${origin}/api/worlds/${world.id}/chat`, { employeeIds: [employee.id], prompt: '第一条长任务', queueMode: 'normal', clientTurnId: 'lane-first' })
  const secondTurn = await postJson<{ session: { id: string } }>(`${origin}/api/worlds/${world.id}/chat`, { employeeIds: [employee.id], prompt: '第二条排队任务', queueMode: 'normal', clientTurnId: 'lane-second' })
  expect(first.status).toBe(202)
  expect(secondTurn.status).toBe(202)
  await expect.poll(async () => (await getJson<{ items: Array<{ id: string; status: string; workTurnId?: string }> }>(`${origin}/api/worlds/${world.id}/chat-queue`)).items.length).toBeGreaterThan(0)
  await expect.poll(async () => {
    const items = (await getJson<{ items: Array<{ status: string }> }>(`${origin}/api/worlds/${world.id}/chat-queue`)).items
    return items.map((item) => item.status).sort()
  }).toEqual(['queued', 'running'])
  await page.reload()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.getByText(/等待中|正在回复中/).first()).toBeVisible()

  const screenshotRoot = join(process.cwd(), 'artifacts', 'conversation-control-runtime-lanes')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1_440, height: 900, label: '1440x900' }, { width: 1_920, height: 1_080, label: '1920x1080' }, { width: 3_840, height: 2_160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await page.locator('.workbench-shell').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `conversation-control-${viewport.label}.png`) })
  }

  const queue = await getJson<{ items: Array<{ id: string; serverQueueId?: string; status: string; workTurnId?: string }> }>(`${origin}/api/worlds/${world.id}/chat-queue`)
  const queued = queue.items.find((item) => item.status === 'queued')
  expect(queued).toBeDefined()
  const queueEntryId = queued!.serverQueueId ?? queued!.id
  const promoted = await patchJson(`${origin}/api/worlds/${world.id}/chat-queue/${queueEntryId}`, { queueMode: 'next' })
  expect(promoted.status).toBe(200)
  const removed = await fetch(`${origin}/api/worlds/${world.id}/chat-queue/${queueEntryId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
  expect(removed.status).toBe(200)

  const running = queue.items.find((item) => item.status === 'running' && item.workTurnId !== undefined)
  if (running?.workTurnId !== undefined) {
    const stopped = await postJson(`${origin}/api/turns/${running.workTurnId}/abort`, { reason: 'user-stop' })
    expect(stopped.status).toBe(200)
    await expect.poll(async () => (await getJson<{ turn: { status: string } }>(`${origin}/api/turns/${running.workTurnId}`)).turn.status).toBe('interrupted')
  }
  expect(current.store.getEmployee(employee.id)).toBeDefined()
  expect(current.store.getEmployee(second.id)).toBeDefined()
  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function recruit(worldId: string): Promise<EmployeeInstance> {
  const result = await postJson<{ employee: EmployeeInstance }>(`${origin}/api/worlds/${worldId}/recruit`, { blueprintId: 'cyber-company.secretary', blueprintVersion: 1, displayName: '并发秘书' })
  expect(result.status).toBe(201)
  return result.body.employee
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

async function patchJson(url: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) }
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('Conversation control E2E 服务尚未启动')
  return server
}

function recordConsole(page: Page, issues: string[]): void {
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') issues.push(`[console:${message.type()}] ${message.text()}`) })
  page.on('pageerror', (error) => issues.push(`[pageerror] ${error.message}`))
}

class LaneRuntime implements AgentRuntimePort {
  readonly #pending = new Map<string, { timer: ReturnType<typeof setTimeout>; reject(error: unknown): void }>()

  async runTurn(request: AgentTurnRequest) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_000)
      if (request.agentRunId !== undefined) this.#pending.set(request.agentRunId, { timer, reject })
    }).finally(() => {
      if (request.agentRunId !== undefined) this.#pending.delete(request.agentRunId)
    })
    return { agentSessionId: request.agent.agentSessionId ?? `agent-${request.agent.id}`, finalResponse: '完成', eventCount: 0 }
  }

  async abortRun(agentRunId: string): Promise<void> {
    const pending = this.#pending.get(agentRunId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pending.reject(new Error('用户停止执行'))
    this.#pending.delete(agentRunId)
  }

  async close(): Promise<void> {
    for (const [agentRunId, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('服务关闭'))
      this.#pending.delete(agentRunId)
    }
  }
}
