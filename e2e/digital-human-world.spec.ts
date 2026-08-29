import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: CyberServer
let origin = ''
let stateRoot = ''
let groupSessionId = ''
let runtime: DigitalHumanRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-digital-human-e2e-'))
  runtime = new DigitalHumanRuntime()
  server = await createCyberServer({ stateRoot, workspacePath: process.cwd(), webRoot: join(process.cwd(), 'packages', 'web', 'dist'), port: 0, bootstrapDefaultWorld: true, runtime })
  origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  for (const input of [
    { blueprintId: 'cyber-company.software-engineer', displayName: '行动工程师' },
    { blueprintId: 'cyber-company.secretary', displayName: '行动协调员' },
  ]) {
    const response = await fetch(`${origin}/api/worlds/${world.id}/recruit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, blueprintVersion: 1 }),
    })
    if (!response.ok) throw new Error(`数字人测试角色创建失败：${response.status} ${await response.text()}`)
  }
  const employees = server.store.listEmployees(world.id)
  const group = server.store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'group',
    title: '行动舱协作',
    participants: [{ participantId: 'owner', kind: 'owner' }, ...employees.slice(0, 3).map((employee) => ({ participantId: employee.id, kind: 'employee' as const }))],
  })
  groupSessionId = group.id
  server.store.appendMessage({ sessionId: group.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '请协作验证数字人行动舱。' })
})

test.afterAll(async () => {
  runtime.release()
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('switches between map and a persistent accessible digital-human world', async ({ page }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    let activeUtterance: { onstart?: (() => void) | null; onend?: (() => void) | null } | undefined
    class MockSpeechSynthesisUtterance {
      lang = ''
      rate = 1
      pitch = 1
      voice: SpeechSynthesisVoice | null = null
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: MockSpeechSynthesisUtterance })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [
          { voiceURI: 'voice-zh-a', name: '中文女声', lang: 'zh-CN', localService: true, default: true },
          { voiceURI: 'voice-zh-b', name: '中文男声', lang: 'zh-CN', localService: true, default: false },
        ],
        addEventListener: (_event: string, listener: () => void) => listener(),
        removeEventListener: () => undefined,
        speak: (utterance: typeof activeUtterance) => { activeUtterance = utterance; utterance?.onstart?.() },
        cancel: () => { const utterance = activeUtterance; activeUtterance = undefined; utterance?.onend?.() },
      },
    })
  })
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const world = server.store.listWorlds(server.store.listWorkspaces()[0]!.id)[0]!
  const modeToggle = page.getByRole('button', { name: '切换到数字人' })
  await expect(modeToggle).toBeVisible()
  await modeToggle.click()

  const actionBay = page.getByRole('region', { name: `${world.name}数字人行动舱` })
  await expect(actionBay).toBeVisible()
  await expect(actionBay).toHaveAttribute('data-state', 'idle')
  await expect(actionBay.getByText('当前会话耐久事实')).toHaveCount(0)
  await expect(actionBay.getByRole('button', { name: /打开.*档案/ })).toBeVisible()
  const statusPanel = actionBay.getByRole('complementary', { name: '数字人状态' })
  await statusPanel.getByRole('button', { name: '收起数字人状态' }).click()
  await expect(statusPanel).toHaveClass(/is-collapsed/)
  await statusPanel.getByRole('button', { name: '展开数字人状态' }).click()
  await expect(actionBay.locator('.digital-human__collaborator')).toHaveCount(2)
  const figure = actionBay.locator('.digital-human__figure')
  await expect.poll(() => figure.evaluate((element) => getComputedStyle(element).animationName)).toContain('digital-human-breathe')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => figure.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => figure.evaluate((element) => getComputedStyle(element).animationName)).toContain('digital-human-breathe')

  const employees = server.store.listEmployees(world.id).slice(0, 3)
  const runningTurn = postJson(`${origin}/api/worlds/${world.id}/chat`, {
    sessionId: groupSessionId,
    employeeIds: employees.map((employee) => employee.id),
    prompt: '执行数字人行动舱联调并汇报状态',
  })
  await expect.poll(() => runtime.requests.length).toBeGreaterThan(0)
  await expect(actionBay).toHaveAttribute('data-state', 'executing')
  await expect.poll(() => figure.evaluate((element) => getComputedStyle(element).animationName)).toContain('digital-human-execute')

  const screenshotRoot = join(process.cwd(), 'artifacts', 'digital-human-world')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(actionBay).toBeVisible()
    expect(await actionBay.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `digital-human-${viewport.label}.png`), fullPage: false })
  }

  await page.setViewportSize({ width: 1_440, height: 900 })
  runtime.release()
  expect((await runningTurn).status).toBe(200)
  await page.reload()
  await expect(actionBay).toBeVisible()
  await actionBay.getByRole('button', { name: '语音回复设置' }).click()
  const voiceMode = actionBay.getByLabel('语音播报模式')
  const voiceSelect = actionBay.getByLabel('数字人语音选择')
  await expect(voiceSelect.locator('option')).toHaveCount(3)
  await voiceSelect.selectOption('voice-zh-b')
  const speakButton = actionBay.getByRole('button', { name: /播放当前回复/ })
  await expect(speakButton).toBeEnabled()
  await speakButton.click()
  await expect(actionBay).toHaveAttribute('data-state', 'speaking')
  await expect(actionBay).toHaveAttribute('data-expression', 'speaking')
  const mouthClosed = await figure.evaluate((element) => getComputedStyle(element).backgroundPosition)
  await page.waitForTimeout(300)
  const mouthOpen = await figure.evaluate((element) => getComputedStyle(element).backgroundPosition)
  expect(mouthOpen).not.toBe(mouthClosed)
  await page.screenshot({ path: join(screenshotRoot, 'digital-human-speaking-1440x900.png'), fullPage: false })
  await actionBay.getByRole('button', { name: /停止播报/ }).click()
  await expect(actionBay).not.toHaveAttribute('data-speaking', 'true')

  const motionToggle = actionBay.getByLabel('启用角色动效')
  await motionToggle.uncheck()
  await expect.poll(() => figure.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')

  await voiceMode.selectOption('auto')
  const autoTurn = await postJson(`${origin}/api/worlds/${world.id}/chat`, {
    sessionId: groupSessionId,
    employeeIds: employees.map((employee) => employee.id),
    prompt: '请生成一条新的自动语音回复',
  })
  expect(autoTurn.status).toBe(200)
  await page.reload()
  await expect(actionBay).toHaveAttribute('data-state', 'speaking')
  await actionBay.getByRole('button', { name: '语音回复设置' }).click()
  await expect(actionBay.getByLabel('语音播报模式')).toHaveValue('auto')
  await expect(actionBay.getByLabel('数字人语音选择')).toHaveValue('voice-zh-b')
  await actionBay.getByRole('button', { name: /停止播报/ }).click()

  await page.getByRole('button', { name: '切换到地图' }).click()
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  await page.getByRole('button', { name: '切换到数字人' }).click()
  await expect(actionBay).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: `${world.name}数字人行动舱` })).toBeVisible()
  await actionBay.getByRole('button', { name: '语音回复设置' }).click()
  await expect(actionBay.getByLabel('启用角色动效')).not.toBeChecked()

  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

class DigitalHumanRuntime implements AgentRuntimePort {
  requests: AgentTurnRequest[] = []
  #released = false
  #waiting = new Set<() => void>()

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    const sourceSessionId = request.agent.agentSessionId ?? `digital-human-${request.agent.id}`
    request.onEvent?.({ kind: 'turn.started', source: 'digital-human-e2e', sourceSessionId, metadata: {} })
    request.onEvent?.({ kind: 'tool.started', source: 'digital-human-e2e', sourceSessionId, toolName: '行动舱联调', callId: `call-${request.agent.id}`, metadata: {} })
    if (!this.#released) await new Promise<void>((resolve) => this.#waiting.add(resolve))
    request.onEvent?.({ kind: 'tool.completed', source: 'digital-human-e2e', sourceSessionId, toolName: '行动舱联调', callId: `call-${request.agent.id}`, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'digital-human-e2e', sourceSessionId, content: `${request.agent.displayName} 已完成行动舱联调。`, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'digital-human-e2e', sourceSessionId, metadata: {} })
    return { agentSessionId: sourceSessionId, finalResponse: `${request.agent.displayName} 已完成行动舱联调。`, eventCount: 5 }
  }

  release(): void {
    this.#released = true
    for (const resolve of this.#waiting) resolve()
    this.#waiting.clear()
  }

  async close(): Promise<void> {
    this.release()
  }
}
