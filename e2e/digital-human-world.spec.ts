import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'
import { interactiveVrmFixture } from './vrm-test-fixture.js'

let server: CyberServer
let origin = ''
let stateRoot = ''
let worldId = ''
let employeeId = ''
let employeeName = ''
let sessionId = ''
let runtime: FocusRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-employee-focus-e2e-'))
  runtime = new FocusRuntime()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
  })
  origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  worldId = world.id
  employeeId = employee.id
  employeeName = employee.displayName
  const initialRevision = server.store.getEmployeeProfile(employee.id)?.revision ?? 0
  const uploaded = await postJson<{ asset: { id: string }; avatarAsset: { rendererKind: string } }>(`${origin}/api/employees/${employee.id}/avatar-assets`, {
    name: 'employee-focus.vrm',
    mimeType: 'model/gltf-binary',
    dataBase64: interactiveVrmFixture().toString('base64'),
  })
  if (uploaded.status !== 201) throw new Error(`VRM fixture 上传失败：${uploaded.status} ${JSON.stringify(uploaded.body)}`)
  const published = await postJson(`${origin}/api/employees/${employee.id}/avatar-assets/${uploaded.body.asset.id}/publish`, {
    fallbackAvatarIndex: 0,
    expectedProfileRevision: initialRevision,
  })
  if (published.status !== 201) throw new Error(`VRM fixture 发布失败：${published.status} ${JSON.stringify(published.body)}`)
  const session = server.store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: `${employee.displayName}聚焦会话`,
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
    ],
  })
  sessionId = session.id
  server.store.appendMessage({ sessionId, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '我已进入员工聚焦，随时可以开始。' })
})

test.afterAll(async () => {
  runtime.release()
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('keeps overview and employee focus continuous while loading and disposing VRM on demand', async ({ page }) => {
  test.setTimeout(120_000)
  await installSpeechMock(page)
  const consoleIssues: string[] = []
  const vrmRequests: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  page.on('request', (request) => { if (isVrmRuntimeRequest(request.url())) vrmRequests.push(request.url()) })
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const map = page.locator('.world-runtime-canvas')
  await expect(map).toBeVisible()
  expect(vrmRequests, '世界概览首屏不得预加载 Three 或 VRM').toEqual([])

  const screenshotRoot = join(process.cwd(), 'artifacts', 'employee-focus')
  await mkdir(screenshotRoot, { recursive: true })
  await page.screenshot({ path: join(screenshotRoot, 'overview-1440x900.png'), fullPage: false })
  await enterFocus(page)
  const focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await page.waitForTimeout(900)
  const rendererKind = await focus.getAttribute('data-renderer')
  if (rendererKind === 'vrm-3d') {
    await expect(focus.locator('canvas[aria-label*="VRM 数字人"]')).toBeVisible({ timeout: 30_000 })
    await expect(focus.locator('.employee-focus__sprite-bridge')).toHaveClass(/is-hidden/)
    expect(vrmRequests.length, '硬件 WebGL 下进入员工聚焦后应按需载入 VRM runtime').toBeGreaterThan(0)
  } else {
    await expect(focus).toHaveAttribute('data-quality', 'static')
    await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()
    expect(vrmRequests, '软件 WebGL 应在下载 VRM runtime 前降级').toEqual([])
  }

  const runningTurn = postJson(`${origin}/api/worlds/${worldId}/chat`, {
    sessionId,
    employeeIds: [employeeId],
    prompt: '请执行一次员工聚焦交互验证',
    clientTurnId: 'employee-focus-e2e-turn',
  })
  await expect.poll(() => runtime.requests.length).toBeGreaterThan(0)
  await expect(focus).toHaveAttribute('data-state', 'executing')

  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(focus).toBeVisible()
    expect(await focus.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `focus-executing-${viewport.label}.png`), fullPage: false })
  }

  runtime.release()
  expect((await runningTurn).status).toBe(200)
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.reload()
  await enterFocus(page)
  await focus.getByRole('button', { name: '语音设置' }).click()
  const mode = focus.getByLabel('播报模式')
  await mode.selectOption('manual')
  await expect(focus.getByLabel('声音').locator('option')).toHaveCount(3)
  await focus.getByLabel('声音').selectOption('voice-zh-b')
  await focus.getByRole('button', { name: '播放当前回复' }).click()
  await expect(focus).toHaveAttribute('data-state', 'speaking')
  await page.screenshot({ path: join(screenshotRoot, 'focus-speaking-1440x900.png'), fullPage: false })
  await focus.getByRole('button', { name: '停止播报' }).click()

  await focus.getByRole('button', { name: '世界' }).click()
  await expect(focus).toHaveCount(0)
  await expect(map).toBeVisible()
  await expect(page.locator('canvas[aria-label*="VRM 数字人"]')).toHaveCount(0)
  await enterFocus(page)
  if (rendererKind === 'vrm-3d') await expect(page.locator('canvas[aria-label*="VRM 数字人"]')).toHaveCount(1)
  else await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()

  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

test('uses the static sprite renderer for reduced motion without loading the VRM runtime', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const vrmRequests: string[] = []
  page.on('request', (request) => { if (isVrmRuntimeRequest(request.url())) vrmRequests.push(request.url()) })
  await page.goto(origin)
  await enterFocus(page)
  const focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toHaveAttribute('data-quality', 'static')
  await expect(focus).toHaveAttribute('data-renderer', 'sprite-2d')
  await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()
  expect(vrmRequests, '减少动态效果时不得下载 VRM runtime').toEqual([])
})

test('previews an uploaded portrait, publishes a new avatar revision, and restores VRM history', async ({ page }) => {
  await page.goto(origin)
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await page.getByRole('button', { name: `修改${employeeName}的名字和头像` }).click()
  const dialog = page.getByRole('dialog', { name: `角色设置 · ${employeeName}` })
  await expect(dialog).toBeVisible()
  const input = dialog.locator('input[type="file"][accept*=".vrm"]')
  await input.setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(ONE_PIXEL_PNG, 'base64') })
  await expect(dialog.getByText('尚未发布')).toBeVisible()
  await expect(dialog.getByText('图片签名已校验，可发布为 2D 角色形象。')).toBeVisible()
  await dialog.getByRole('button', { name: '发布到角色' }).click()
  await expect(dialog.getByRole('img', { name: `${employeeName}形象预览` })).toBeVisible()
  const restore = dialog.getByRole('button', { name: '恢复', exact: true }).first()
  await expect(restore).toBeVisible()
  await restore.click()
  await expect(dialog.locator('.character-avatar-manager__stage')).toHaveAttribute('data-kind', 'vrm-3d')
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'employee-focus', 'avatar-version-history-1440x900.png'), fullPage: false })
})

async function enterFocus(page: Page): Promise<void> {
  await page.getByRole('button', { name: `${employeeName}世界角色` }).evaluate((element) => (element as HTMLButtonElement).click())
  await expect(page.getByRole('region', { name: `${employeeName}员工聚焦` })).toBeVisible()
}

async function installSpeechMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let active: { onstart?: (() => void) | null; onend?: (() => void) | null } | undefined
    class MockSpeechSynthesisUtterance {
      lang = ''; rate = 1; pitch = 1; voice: SpeechSynthesisVoice | null = null
      onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null
      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: MockSpeechSynthesisUtterance })
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [
        { voiceURI: 'voice-zh-a', name: '中文女声', lang: 'zh-CN', localService: true, default: true },
        { voiceURI: 'voice-zh-b', name: '中文男声', lang: 'zh-CN', localService: true, default: false },
      ],
      addEventListener: (_event: string, listener: () => void) => listener(), removeEventListener: () => undefined,
      speak: (utterance: typeof active) => { active = utterance; utterance?.onstart?.() },
      cancel: () => { const utterance = active; active = undefined; utterance?.onend?.() },
    } })
  })
}

function isVrmRuntimeRequest(url: string): boolean {
  return /vrm-runtime|VrmRuntimeRenderer|three-vrm|GLTFLoader/iu.test(url)
}

async function postJson<T = unknown>(url: string, body: Record<string, unknown>): Promise<{ status: number; body: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => undefined) as T }
}

class FocusRuntime implements AgentRuntimePort {
  requests: AgentTurnRequest[] = []
  #released = false
  #waiting = new Set<() => void>()

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    const sourceSessionId = request.agent.agentSessionId ?? `employee-focus-${request.agent.id}`
    request.onEvent?.({ kind: 'turn.started', source: 'employee-focus-e2e', sourceSessionId, metadata: {} })
    request.onEvent?.({ kind: 'tool.started', source: 'employee-focus-e2e', sourceSessionId, toolName: '员工聚焦验证', callId: `call-${request.agent.id}`, metadata: {} })
    if (!this.#released) await new Promise<void>((resolve) => this.#waiting.add(resolve))
    request.onEvent?.({ kind: 'tool.completed', source: 'employee-focus-e2e', sourceSessionId, toolName: '员工聚焦验证', callId: `call-${request.agent.id}`, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'employee-focus-e2e', sourceSessionId, content: `${request.agent.displayName} 已完成员工聚焦交互验证。`, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'employee-focus-e2e', sourceSessionId, metadata: {} })
    return { agentSessionId: sourceSessionId, finalResponse: `${request.agent.displayName} 已完成员工聚焦交互验证。`, eventCount: 5 }
  }

  release(): void {
    this.#released = true
    for (const resolve of this.#waiting) resolve()
    this.#waiting.clear()
  }

  async close(): Promise<void> { this.release() }
}

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
