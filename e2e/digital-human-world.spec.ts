import { mkdtemp, rm } from 'node:fs/promises'
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
let secondEmployeeName = ''
let thirdEmployeeName = ''
let sessionId = ''
const groupSessionTitle = '三人数字人讨论'
let runtime: FocusRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-core-world-e2e-'))
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

  // Deliberately publish a VRM. Core map/2D must still stay lightweight merely
  // because optional 3D data exists for the employee.
  const initialRevision = server.store.getEmployeeProfile(employee.id)?.revision ?? 0
  const uploaded = await postJson<{ asset: { id: string } }>(`${origin}/api/employees/${employee.id}/avatar-assets`, {
    name: 'unused-by-core.vrm',
    mimeType: 'model/gltf-binary',
    dataBase64: interactiveVrmFixture().toString('base64'),
  })
  if (uploaded.status !== 201) throw new Error(`VRM fixture 上传失败：${uploaded.status}`)
  const published = await postJson(`${origin}/api/employees/${employee.id}/avatar-assets/${uploaded.body.asset.id}/publish`, {
    fallbackAvatarIndex: 0,
    expectedProfileRevision: initialRevision,
  })
  if (published.status !== 201) throw new Error(`VRM fixture 发布失败：${published.status}`)

  for (const input of [
    { blueprintId: 'cyber-company.software-engineer', displayName: '协作工程师' },
    { blueprintId: 'cyber-company.secretary', displayName: '协作协调员' },
  ]) {
    const response = await fetch(`${origin}/api/worlds/${world.id}/recruit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, blueprintVersion: 1 }),
    })
    if (!response.ok) throw new Error(`协作角色创建失败：${response.status}`)
  }
  const recruited = server.store.listEmployees(world.id)
  const secondEmployee = recruited.find((item) => item.displayName === '协作工程师')!
  const thirdEmployee = recruited.find((item) => item.displayName === '协作协调员')!
  secondEmployeeName = secondEmployee.displayName
  thirdEmployeeName = thirdEmployee.displayName

  const session = server.store.listSessions(world.id).find((candidate) => candidate.kind === 'direct'
    && server.store.listParticipants(candidate.id).some((participant) => participant.participantId === employee.id))
  if (session === undefined) throw new Error('默认角色 canonical 私聊不存在')
  sessionId = session.id
  server.store.appendMessage({ sessionId, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '我已进入员工聚焦，随时可以开始。' })

  const group = server.store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'group',
    title: groupSessionTitle,
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
      { participantId: secondEmployee.id, kind: 'employee' },
      { participantId: thirdEmployee.id, kind: 'employee' },
    ],
  })
  server.store.appendMessage({ sessionId: group.id, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '主角色先说明背景。' })
  server.store.appendMessage({ sessionId: group.id, senderId: secondEmployee.id, senderKind: 'employee', kind: 'assistant', content: '协作工程师补充技术方案。' })
  server.store.appendMessage({ sessionId: group.id, senderId: thirdEmployee.id, senderKind: 'employee', kind: 'assistant', content: '协作协调员给出最新汇总。' })
})

test.afterAll(async () => {
  runtime.release()
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('keeps core map and 2D focus continuous without loading optional 3D', async ({ page }) => {
  const consoleIssues: string[] = []
  const spatialRequests: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  recordOptional3dRequests(page, spatialRequests)
  await page.addInitScript((id) => localStorage.setItem(`dsh-cyber-world-view:${id}`, 'map'), worldId)
  await page.goto(origin)

  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.locator('.world-canvas-host')).toHaveAttribute('data-renderer-kind', 'pixi-2d')
  const display = page.getByRole('tablist', { name: '世界显示方式' })
  await expect(display.getByRole('tab')).toHaveCount(2)
  await expect(display.getByRole('tab', { name: '平面', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(display.getByRole('tab', { name: '2D', exact: true })).toBeVisible()
  await expect(display.getByRole('tab', { name: '3D', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: '世界镜头' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '世界扩展' })).toBeVisible()
  expect(spatialRequests, '核心世界首屏不得请求 3D runtime 或 Avatar Base Pack').toEqual([])

  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const focus = await selectCore2dView(page, employeeName)
  expect(spatialRequests, '进入核心 2D 聚焦不得请求 3D runtime').toEqual([])

  const before = runtime.requests.length
  const runningTurn = postJson(`${origin}/api/worlds/${worldId}/chat`, {
    sessionId,
    employeeIds: [employeeId],
    prompt: '请执行一次核心 2D 员工聚焦交互验证',
    clientTurnId: 'core-2d-focus-e2e-turn',
  })
  await expect.poll(() => runtime.requests.length).toBeGreaterThan(before)
  await expect(focus).toHaveAttribute('data-state', 'executing')
  runtime.release()
  expect((await runningTurn).status).toBe(200)

  await display.getByRole('tab', { name: '平面', exact: true }).click()
  await expect(page.getByRole('region', { name: `${employeeName}员工聚焦` })).toHaveCount(0)
  await expect(page.locator('.world-canvas-host')).toBeVisible()
  expect(spatialRequests, '完整核心流程不得隐式加载 3D 扩展').toEqual([])
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

test('migrates legacy 3D state into core without reopening a spatial renderer', async ({ page }) => {
  const spatialRequests: string[] = []
  recordOptional3dRequests(page, spatialRequests)
  await page.addInitScript((id) => localStorage.setItem(`dsh-cyber-world-view:${id}`, '3d/follow'), worldId)
  await page.goto(origin)

  const display = page.getByRole('tablist', { name: '世界显示方式' })
  await expect(display.getByRole('tab', { name: '2D', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(display.getByRole('tab', { name: '3D', exact: true })).toHaveCount(0)
  await expect(page.locator('.world-canvas-host')).toHaveAttribute('data-renderer-kind', 'pixi-2d')
  expect(spatialRequests).toEqual([])
})

test('keeps reduced-motion core 2D static without loading optional 3D', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const spatialRequests: string[] = []
  recordOptional3dRequests(page, spatialRequests)
  await page.goto(origin)
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const focus = await selectCore2dView(page, employeeName)
  await expect(focus).toHaveAttribute('data-quality', 'static')
  await expect(focus).toHaveAttribute('data-renderer', 'sprite-2d')
  await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()
  expect(spatialRequests).toEqual([])
})

test('pastes a clipboard image into the existing composer attachment flow', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  await page.goto(origin)
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.evaluate((element, pngBase64) => {
    const bytes = Uint8Array.from(atob(pngBase64), (character) => character.charCodeAt(0))
    const file = new File([bytes], 'clipboard.png', { type: 'image/png' })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } })
    element.dispatchEvent(event)
  }, ONE_PIXEL_PNG)

  const preview = page.locator('.composer-attachments__preview')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveAttribute('alt', /粘贴图片-.+预览/u)
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

test('keeps 2D selected across conversations and follows the latest group speaker', async ({ page }) => {
  const spatialRequests: string[] = []
  recordOptional3dRequests(page, spatialRequests)
  await page.goto(origin)
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  await selectCore2dView(page, employeeName)

  await page.getByRole('button', { name: `与${secondEmployeeName}私聊`, exact: true }).click()
  await expect(page.getByRole('region', { name: `${secondEmployeeName}员工聚焦` })).toBeVisible()
  await expect(page.getByRole('tab', { name: '2D', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: '3D', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: groupSessionTitle, exact: true }).click()
  const focus = page.getByRole('region', { name: `${thirdEmployeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await expect(focus.getByRole('button', { name: `聚焦${employeeName}数字人` })).toBeVisible()
  await expect(focus.getByRole('button', { name: `聚焦${secondEmployeeName}数字人` })).toBeVisible()
  await expect(page.getByRole('tab', { name: '轨迹', exact: true })).toBeVisible()
  expect(spatialRequests).toEqual([])
})

test('turns streaming voice partials into the core 2D conversation flow', async ({ page }) => {
  await installVoiceConversationMock(page)
  await page.goto(origin)
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const focus = await selectCore2dView(page, employeeName)
  const microphone = focus.getByRole('button', { name: '开始语音对话' })
  await expect(microphone).toBeEnabled()
  await microphone.press('Enter')
  await expect(focus.getByText('正在听你说话')).toBeVisible()
  await expect(focus.getByText('帮我检查昨天的服务日志')).toBeVisible()
  await expect(page.getByText('帮我检查昨天的服务日志', { exact: true }).first()).toBeVisible()
  await expect(focus.getByRole('button', { name: '结束语音对话' })).toBeVisible()
  await focus.getByRole('button', { name: '结束语音对话' }).click()
  await expect(focus.getByRole('button', { name: '开始语音对话' })).toBeVisible()
})

/**
 * Regression guard for `fix:voice-conversation-ownership` (5ea7bde).
 *
 * A reply used to be able to play twice — the focused character panel and the
 * composer fallback both saw the same streamed turn — and a typed reply could
 * inherit the previous voice turn's ownership and speak on its own. Both
 * surfaces are core 2D concerns; the renderer is not part of the bug.
 */
test('speaks a composer voice turn exactly once and leaves typed replies silent', async ({ page }) => {
  test.setTimeout(120_000)
  await installVoiceConversationMock(page, '语音模式联合回归')
  const streamRequests: Array<{ text?: string; provider?: string }> = []
  await recordLocalTtsRequests(page, streamRequests)
  await page.goto(origin)
  runtime.release()
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const focus = await selectCore2dView(page, employeeName)

  // The focused panel broadcasts new replies on its own. That is the second
  // owner the composer fallback has to lose to, so turn it on explicitly.
  await focus.getByRole('button', { name: '语音设置' }).click()
  await focus.getByLabel('播报模式').selectOption('auto')
  await focus.getByRole('button', { name: '语音设置' }).click()

  const composer = page.locator('.composer-zone')
  const expectedReplyText = `${employeeName} 已完成员工聚焦交互验证。`
  for (const turn of [1, 2]) {
    const microphone = composer.getByRole('button', { name: '开始语音对话' })
    await expect(microphone).toBeVisible()
    await microphone.click()
    await expect(composer.getByRole('button', { name: '结束语音对话' })).toBeVisible()
    await expect(page.getByText('语音模式联合回归', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => streamRequests.filter((request) => request.text === expectedReplyText).length).toBe(turn)
    // Poll succeeds on the way up, so give a duplicate owner time to appear.
    await page.waitForTimeout(400)
    expect(streamRequests.filter((request) => request.text === expectedReplyText).length,
      `第 ${turn} 个语音 turn 只能播报一次：${JSON.stringify(streamRequests)}`).toBe(turn)
    await composer.getByRole('button', { name: '结束语音对话' }).click()
    await expect(composer.getByRole('button', { name: '开始语音对话' })).toBeVisible()
  }

  // Nothing may be spoken in another character's name.
  expect(streamRequests.map((request) => request.text ?? ''),
    `播报内容必须属于当前聚焦角色：${JSON.stringify(streamRequests)}`)
    .toEqual(streamRequests.map(() => expectedReplyText))

  // Turn off the focused panel's independent auto mode so the next assertion is
  // specifically about the composer origin. A typed turn must not inherit the
  // preceding voice turn's ownership or generate another TTS request.
  await focus.getByRole('button', { name: '语音设置' }).click()
  await focus.getByLabel('播报模式').selectOption('off')
  await focus.getByRole('button', { name: '语音设置' }).click()
  const beforeTyped = streamRequests.length
  const runtimeTurnsBeforeTyped = runtime.requests.length
  await page.getByRole('textbox', { name: '给当前世界的角色发送消息' }).fill('这是键盘输入，不应自动播报')
  await composer.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => runtime.requests.length).toBeGreaterThan(runtimeTurnsBeforeTyped)
  await expect(page.getByText('这是键盘输入，不应自动播报', { exact: true }).first()).toBeVisible()
  await page.waitForTimeout(500)
  expect(streamRequests.length, `键盘 turn 不得继承 voice turn 的播报所有权：${JSON.stringify(streamRequests)}`).toBe(beforeTyped)
})

/**
 * Regression guard for the 2D image avatar path.
 *
 * Upload, publish, immutable revision and rollback are core product behaviour
 * for `image-2d` portraits and are unrelated to the optional 3D extension, so
 * this deliberately uses a character with no VRM published.
 */
test('publishes an uploaded 2D portrait and rolls back to an earlier revision', async ({ page }) => {
  const spatialRequests: string[] = []
  recordOptional3dRequests(page, spatialRequests)
  await page.goto(origin)
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  await page.getByRole('button', { name: `修改${secondEmployeeName}的名字和头像`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `角色设置 · ${secondEmployeeName}` })
  await expect(dialog).toBeVisible()
  const stage = dialog.locator('.character-avatar-manager__stage')
  const summary = dialog.locator('.character-avatar-manager__summary')
  const fileInput = dialog.locator('input[type="file"][accept*=".vrm"]')

  await fileInput.setInputFiles({ name: 'portrait-a.png', mimeType: 'image/png', buffer: Buffer.from(PORTRAIT_A_PNG, 'base64') })
  await expect(dialog.getByText('尚未发布')).toBeVisible()
  await expect(dialog.getByText('图片签名已校验，可发布为 2D 角色形象。')).toBeVisible()
  await expect(stage).toHaveAttribute('data-kind', 'image-2d')
  await dialog.getByRole('button', { name: '发布到角色' }).click()
  await expect(dialog.getByText('尚未发布')).toHaveCount(0)
  await expect(stage.getByRole('img', { name: `${secondEmployeeName}形象预览` })).toBeVisible()
  await expect(summary.getByText('portrait-a.png', { exact: true })).toBeVisible()

  await fileInput.setInputFiles({ name: 'portrait-b.png', mimeType: 'image/png', buffer: Buffer.from(PORTRAIT_B_PNG, 'base64') })
  await dialog.getByRole('button', { name: '发布到角色' }).click()
  await expect(summary.getByText('portrait-b.png', { exact: true })).toBeVisible()

  // Publishing keeps every earlier revision readable, so the first portrait is
  // still offered as history rather than having been overwritten.
  const history = dialog.locator('.character-avatar-manager__history li').filter({ hasText: 'portrait-a.png' })
  await expect(history).toHaveCount(1)
  await history.getByRole('button', { name: '恢复', exact: true }).click()

  await expect(summary.getByText('portrait-a.png', { exact: true })).toBeVisible()
  await expect(stage).toHaveAttribute('data-kind', 'image-2d')
  await expect(stage.getByRole('img', { name: `${secondEmployeeName}形象预览` })).toBeVisible()
  // Rollback creates a new revision instead of rewriting history: the portrait
  // it replaced is now itself an entry that can be restored.
  await expect(dialog.locator('.character-avatar-manager__history li').filter({ hasText: 'portrait-b.png' })).toHaveCount(1)
  expect(spatialRequests, '2D 形象发布与回滚不得加载 3D 扩展').toEqual([])
})

async function selectCore2dView(page: Page, employee: string) {
  const display = page.getByRole('tablist', { name: '世界显示方式' })
  const tab = display.getByRole('tab', { name: '2D', exact: true })
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const focus = page.getByRole('region', { name: `${employee}员工聚焦` })
  await expect(focus).toBeVisible()
  return focus
}

function recordOptional3dRequests(page: Page, target: string[]): void {
  page.on('request', (request) => {
    if (/vrm-runtime|VrmRuntimeRenderer|three-vrm|GLTFLoader|SpatialWorldExtensionDialog|avatar-base-packs/iu.test(request.url())) {
      target.push(request.url())
    }
  })
}

async function installVoiceConversationMock(page: Page, finalText = '帮我检查昨天的服务日志'): Promise<void> {
  await page.addInitScript((spokenText) => {
    class MockWebSocket {
      static OPEN = 1
      readyState = 1
      binaryType = ''
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null
      listeners = new Map<string, Array<() => void>>()
      constructor(readonly url: string) {
        window.setTimeout(() => { this.onopen?.(); for (const listener of this.listeners.get('open') ?? []) listener() }, 0)
      }
      addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(data: string | ArrayBuffer) {
        if (typeof data !== 'string') return
        const command = JSON.parse(data) as { type: string }
        if (command.type === 'prepare') this.emit({ type: 'prepared' })
        if (command.type === 'start') {
          this.emit({ type: 'session-started', sessionId: 'voice-test' })
          this.emit({ type: 'listening', sessionId: 'voice-test' })
          window.setTimeout(() => this.emit({ type: 'speech-start', sessionId: 'voice-test', utteranceId: 'voice-test:0' }), 100)
          window.setTimeout(() => this.emit({ type: 'partial', sessionId: 'voice-test', utteranceId: 'voice-test:0', text: spokenText.slice(0, Math.max(1, Math.floor(spokenText.length / 2))) }), 250)
          window.setTimeout(() => this.emit({ type: 'partial', sessionId: 'voice-test', utteranceId: 'voice-test:0', text: spokenText }), 500)
          window.setTimeout(() => this.emit({ type: 'final', sessionId: 'voice-test', utteranceId: 'voice-test:0', text: spokenText }), 1_300)
        }
      }
      close() { this.readyState = 3; this.onclose?.() }
      emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }) }
    }
    class MockAudioWorkletNode {
      port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null }
      constructor(_context: unknown, _name: string) {}
      connect() { return this }
      disconnect() {}
    }
    class MockAudioContext {
      destination = {}
      audioWorklet = { addModule: async (_url: string) => undefined }
      createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined } }
      createGain() { return { gain: { value: 1 }, connect: () => undefined } }
      close() { return Promise.resolve() }
    }
    const fakeStream = { getTracks: () => [{ stop: () => undefined }] }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket })
    Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: MockAudioWorkletNode })
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: MockAudioContext })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => fakeStream } })
  }, finalText)
}

/**
 * Answers every local TTS request with a fast failure and records what was asked for.
 *
 * Counting requests is the whole point: playback ownership is what is under
 * test, not audio. A 503 keeps the assertion honest without pretending a local
 * voice pack or a microphone device was really installed.
 */
async function recordLocalTtsRequests(page: Page, target: Array<{ text?: string; provider?: string }>): Promise<void> {
  await page.route('**/api/local-tts/models', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ models: [
      { id: 'moss-tts-nano-100m-onnx', provider: 'moss', displayName: 'MOSS-TTS-Nano', version: '100M', license: 'Apache-2.0', byteLength: 1, state: 'not-installed', tier: 'default', recommended: true, runtime: 'onnx-cpu', summary: '测试语音包。' },
      { id: 'kokoro-int8-multi-lang-v1_1', provider: 'kokoro', displayName: 'Kokoro 快速语音', version: '1.1', license: 'Apache-2.0', byteLength: 1, state: 'ready', tier: 'fast', runtime: 'onnx-cpu', summary: '测试备用语音。' },
    ] }),
  }))
  await page.route('**/api/local-tts/stream', async (route) => {
    try { target.push(JSON.parse(route.request().postData() ?? '{}') as { text?: string; provider?: string }) } catch { target.push({}) }
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试环境未安装本地语音包' } }) })
  })
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
    const sourceSessionId = request.agent.agentSessionId ?? `core-world-${request.agent.id}`
    request.onEvent?.({ kind: 'turn.started', source: 'core-world-e2e', sourceSessionId, metadata: {} })
    request.onEvent?.({ kind: 'tool.started', source: 'core-world-e2e', sourceSessionId, toolName: '核心聚焦验证', callId: `call-${request.agent.id}`, metadata: {} })
    if (!this.#released) await new Promise<void>((resolve) => this.#waiting.add(resolve))
    request.onEvent?.({ kind: 'tool.completed', source: 'core-world-e2e', sourceSessionId, toolName: '核心聚焦验证', callId: `call-${request.agent.id}`, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'core-world-e2e', sourceSessionId, content: `${request.agent.displayName} 已完成员工聚焦交互验证。`, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'core-world-e2e', sourceSessionId, metadata: {} })
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
// Two distinct 2x2 PNGs so the published revisions differ by content, not only by name.
const PORTRAIT_A_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4oaFxQkODAUIBACEuBGGeECA5AAAAAElFTkSuQmCC'
const PORTRAIT_B_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGPQCDihEXCCAUIBACCOBQEyq3EUAAAAAElFTkSuQmCC'
