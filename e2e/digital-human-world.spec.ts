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
let secondEmployeeId = ''
let secondEmployeeName = ''
let thirdEmployeeId = ''
let thirdEmployeeName = ''
let sessionId = ''
let groupSessionId = ''
const groupSessionTitle = '三人数字人讨论'
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
  for (const input of [
    { blueprintId: 'cyber-company.software-engineer', displayName: '协作工程师' },
    { blueprintId: 'cyber-company.secretary', displayName: '协作协调员' },
  ]) {
    const response = await fetch(`${origin}/api/worlds/${world.id}/recruit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, blueprintVersion: 1 }),
    })
    if (!response.ok) throw new Error(`数字人协作角色创建失败：${response.status} ${await response.text()}`)
  }
  const recruited = server.store.listEmployees(world.id)
  const secondEmployee = recruited.find((item) => item.displayName === '协作工程师')!
  const thirdEmployee = recruited.find((item) => item.displayName === '协作协调员')!
  secondEmployeeId = secondEmployee.id
  secondEmployeeName = secondEmployee.displayName
  thirdEmployeeId = thirdEmployee.id
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
  groupSessionId = group.id
  server.store.appendMessage({ sessionId: group.id, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '主角色先说明背景。' })
  server.store.appendMessage({ sessionId: group.id, senderId: secondEmployee.id, senderKind: 'employee', kind: 'assistant', content: '协作工程师补充技术方案。' })
  server.store.appendMessage({ sessionId: group.id, senderId: thirdEmployee.id, senderKind: 'employee', kind: 'assistant', content: '协作协调员给出最新汇总。' })
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
  await page.addInitScript((currentWorldId) => localStorage.setItem(`dsh-cyber-world-view:${currentWorldId}`, 'map'), worldId)
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const map = page.locator('.world-runtime-canvas')
  await expect(map).toBeVisible()
  expect(vrmRequests, '世界概览首屏不得预加载 Three 或 VRM').toEqual([])
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()

  const screenshotRoot = join(process.cwd(), 'artifacts', 'employee-focus')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const displaySwitch = page.getByRole('tablist', { name: '世界显示方式' })
    await expect(displaySwitch).toBeVisible()
    await expect(displaySwitch.getByRole('tab', { name: '地图', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(await displaySwitch.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `world-view-switch-${viewport.label}.png`), fullPage: false })
  }
  await page.setViewportSize({ width: 1_440, height: 900 })
  await selectCharacterView(page, '3D', employeeName)
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
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  await selectCharacterView(page, '3D', employeeName)
  await focus.getByRole('button', { name: '语音设置' }).click()
  const mode = focus.getByLabel('播报模式')
  await mode.selectOption('manual')
  await expect(focus.getByLabel('角色声音', { exact: true }).locator('option')).toHaveCount(103)
  await focus.getByLabel('角色声音', { exact: true }).selectOption('system:voice-zh-b')
  await focus.getByRole('button', { name: '试听声音' }).click()
  await expect.poll(() => lastSpokenVoice(page)).toBe('voice-zh-b')
  await focus.getByRole('button', { name: '停止播报' }).click()
  await focus.getByRole('button', { name: `播放${employeeName}的回复` }).click()
  await expect(focus).toHaveAttribute('data-state', 'speaking')
  await expect.poll(() => lastSpokenText(page)).toContain(`${employeeName} 已完成员工聚焦交互验证。`)
  await page.screenshot({ path: join(screenshotRoot, 'focus-speaking-1440x900.png'), fullPage: false })
  await focus.getByRole('button', { name: '停止播报' }).click()

  await page.getByRole('tab', { name: '地图', exact: true }).click()
  await expect(focus).toHaveCount(0)
  await expect(map).toBeVisible()
  await expect(page.locator('canvas[aria-label*="VRM 数字人"]')).toHaveCount(0)
  await selectCharacterView(page, '3D', employeeName)
  if (rendererKind === 'vrm-3d') await expect(page.locator('canvas[aria-label*="VRM 数字人"]')).toHaveCount(1)
  else await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()

  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

test('uses the static sprite renderer for reduced motion without loading the VRM runtime', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const vrmRequests: string[] = []
  page.on('request', (request) => { if (isVrmRuntimeRequest(request.url())) vrmRequests.push(request.url()) })
  await page.addInitScript((currentWorldId) => localStorage.setItem(`dsh-cyber-world-view:${currentWorldId}`, 'map'), worldId)
  await page.goto(origin)
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  await selectCharacterView(page, '3D', employeeName)
  const focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toHaveAttribute('data-quality', 'static')
  await expect(focus).toHaveAttribute('data-renderer', 'sprite-2d')
  await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()
  expect(vrmRequests, '减少动态效果时不得下载 VRM runtime').toEqual([])
})

test('keeps the chosen 2D view across conversations and centers the latest group speaker', async ({ page }) => {
  await installSpeechMock(page)
  await page.goto(origin)
  const twoDimensionalTab = page.getByRole('tab', { name: '2D', exact: true })
  await expect(twoDimensionalTab).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  let focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await focus.getByRole('button', { name: '语音设置' }).click()
  await expect(focus.getByLabel('角色声音', { exact: true }).locator('option')).toHaveCount(103)
  await focus.getByLabel('角色声音', { exact: true }).selectOption('system:voice-zh-a')

  await page.getByRole('button', { name: `与${secondEmployeeName}私聊`, exact: true }).click()
  focus = page.getByRole('region', { name: `${secondEmployeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await expect(twoDimensionalTab).toHaveAttribute('aria-selected', 'true')
  await focus.getByRole('button', { name: '语音设置' }).click()
  await expect(focus.getByLabel('角色声音', { exact: true }).locator('option')).toHaveCount(103)
  await focus.getByLabel('角色声音', { exact: true }).selectOption('system:voice-zh-b')

  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await focus.getByRole('button', { name: '语音设置' }).click()
  await expect(focus.getByLabel('角色声音', { exact: true })).toHaveValue('system:voice-zh-a')

  await page.getByRole('button', { name: groupSessionTitle, exact: true }).click()
  focus = page.getByRole('region', { name: `${thirdEmployeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await expect(focus.getByRole('button', { name: `聚焦${employeeName}数字人` })).toBeVisible()
  await expect(focus.getByRole('button', { name: `聚焦${secondEmployeeName}数字人` })).toBeVisible()
  await expect(focus.locator('.employee-focus__actions')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '轨迹', exact: true })).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'employee-focus', 'group-latest-speaker-1440x900.png'), fullPage: false })
})

test('turns streaming voice partials into the existing conversation message flow', async ({ page }) => {
  await installVoiceConversationMock(page)
  await page.goto(origin)
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
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

async function selectCharacterView(page: Page, mode: '2D' | '3D', expectedEmployeeName: string): Promise<void> {
  const tab = page.getByRole('tab', { name: mode, exact: true })
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: `${expectedEmployeeName}员工聚焦` })).toBeVisible()
}

async function installSpeechMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let active: { onstart?: (() => void) | null; onend?: (() => void) | null } | undefined
    let loaded = false
    const listeners = new Set<() => void>()
    const initialVoices = [
      { voiceURI: 'voice-zh-a', name: '中文女声', lang: 'zh-CN', localService: true, default: true },
      { voiceURI: 'voice-en-a', name: 'English Voice', lang: 'en-US', localService: true, default: false },
    ]
    const fullVoices = [
      initialVoices[0]!,
      { voiceURI: 'voice-zh-b', name: '中文男声', lang: 'zh-CN', localService: true, default: false },
      { voiceURI: 'voice-zh-c', name: '中文自然声', lang: 'zh-TW', localService: false, default: false },
      initialVoices[1]!,
      { voiceURI: 'voice-ja-a', name: '日本語', lang: 'ja-JP', localService: true, default: false },
      { voiceURI: 'voice-ko-a', name: '한국어', lang: 'ko-KR', localService: false, default: false },
    ]
    class MockSpeechSynthesisUtterance {
      lang = ''; rate = 1; pitch = 1; voice: SpeechSynthesisVoice | null = null
      onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null
      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: MockSpeechSynthesisUtterance })
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => loaded ? fullVoices : initialVoices,
      addEventListener: (event: string, listener: () => void) => { if (event === 'voiceschanged') listeners.add(listener) },
      removeEventListener: (event: string, listener: () => void) => { if (event === 'voiceschanged') listeners.delete(listener) },
      speak: (utterance: typeof active & { text?: string; voice?: { voiceURI?: string } | null }) => {
        active = utterance
        ;(window as typeof window & { __dshSpeechLog?: Array<{ text: string; voiceURI: string | null }> }).__dshSpeechLog ??= []
        ;(window as typeof window & { __dshSpeechLog: Array<{ text: string; voiceURI: string | null }> }).__dshSpeechLog.push({ text: utterance?.text ?? '', voiceURI: utterance?.voice?.voiceURI ?? null })
        utterance?.onstart?.()
      },
      cancel: () => { const utterance = active; active = undefined; utterance?.onend?.() },
    } })
    window.setTimeout(() => { loaded = true; for (const listener of listeners) listener() }, 140)
  })
}

async function installVoiceConversationMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
          window.setTimeout(() => this.emit({ type: 'partial', sessionId: 'voice-test', utteranceId: 'voice-test:0', text: '帮我检查昨天' }), 250)
          window.setTimeout(() => this.emit({ type: 'partial', sessionId: 'voice-test', utteranceId: 'voice-test:0', text: '帮我检查昨天的服务日志' }), 500)
          window.setTimeout(() => this.emit({ type: 'final', sessionId: 'voice-test', utteranceId: 'voice-test:0', text: '帮我检查昨天的服务日志' }), 1_300)
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
  })
}

async function lastSpokenVoice(page: Page): Promise<string> {
  return page.evaluate(() => {
    const latest = (window as typeof window & { __dshSpeechLog?: Array<{ voiceURI: string | null }> }).__dshSpeechLog?.at(-1)
    return latest?.voiceURI ?? 'system-default'
  })
}

async function lastSpokenText(page: Page): Promise<string> {
  return page.evaluate(() => (window as typeof window & { __dshSpeechLog?: Array<{ text: string }> }).__dshSpeechLog?.at(-1)?.text ?? '')
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
