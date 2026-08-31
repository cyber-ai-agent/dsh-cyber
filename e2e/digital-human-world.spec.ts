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
    // "Map" used to be a third world alongside 2D and 3D. It is now the
    // overview camera: how the world is drawn and where the camera looks are
    // separate questions, so the default is the 2D renderer showing everybody.
    await expect(displaySwitch.getByRole('tab', { name: '2D', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tablist', { name: '世界镜头' }).getByRole('tab', { name: '全景', exact: true })).toHaveAttribute('aria-selected', 'true')
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
    await expectCharacterVisible(page, employeeName)
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

  await page.getByRole('tab', { name: '全景', exact: true }).click()
  await expect(focus).toHaveCount(0)
  await expect(map).toBeVisible()
  await expect(page.locator('canvas[aria-label*="VRM 数字人"]')).toHaveCount(0)
  await selectCharacterView(page, '3D', employeeName)
  if (rendererKind === 'vrm-3d') await expect(page.locator('canvas[aria-label*="VRM 数字人"]')).toHaveCount(1)
  else await expectCharacterVisible(page, employeeName)

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
  await expectCharacterVisible(page, employeeName)
  expect(vrmRequests, '减少动态效果时不得下载 VRM runtime').toEqual([])
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

test('keeps the chosen 2D view across conversations and centers the latest group speaker', async ({ page }) => {
  await installSpeechMock(page)
  const avatarCreationRequests: string[] = []
  page.on('request', (request) => { if (/avatar-creation-provider|procedural-vrm\.worker/iu.test(request.url())) avatarCreationRequests.push(request.url()) })
  await page.goto(origin)
  expect(avatarCreationRequests, '普通 2D 会话不得预加载 3D 创建代码').toEqual([])
  const twoDimensionalTab = page.getByRole('tab', { name: '2D', exact: true })
  await expect(twoDimensionalTab).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  let focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await focus.getByRole('button', { name: '语音设置' }).click()
  const voiceModels = focus.getByRole('region', { name: '语音模型包' })
  const voiceEngine = voiceModels.getByLabel('语音引擎', { exact: true })
  await expect(voiceEngine.locator('option')).toHaveCount(6)
  await voiceEngine.selectOption('moss-tts-nano-100m-onnx')
  await expect(voiceModels.getByRole('button', { name: '下载并安装' })).toBeVisible()
  await voiceEngine.selectOption('dots-tts-soar-2b')
  // "高级模型" read as a premium tier. The truth is narrower and more useful:
  // this engine cannot run on this machine in this version.
  await expect(voiceModels.getByText('本机暂不支持', { exact: true })).toBeVisible()
  await voiceEngine.selectOption('kokoro-int8-multi-lang-v1_1')
  await expect(focus.getByLabel('角色声音', { exact: true }).locator('option')).toHaveCount(103)
  await focus.getByLabel('角色声音', { exact: true }).selectOption('system:voice-zh-a')
  await expect(focus.getByRole('slider', { name: '语速' })).toHaveValue('1.1')
  await focus.getByRole('slider', { name: '语速' }).fill('1.25')
  await expect(focus.getByText('1.25×', { exact: true })).toBeVisible()
  await focus.getByRole('button', { name: '试听声音' }).click()
  await expect.poll(() => lastSpokenRate(page)).toBe(1.25)
  await focus.getByRole('button', { name: '停止播报' }).click()
  const firstVoiceSaved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes(`/api/employees/${employeeId}/profile`) && response.status() === 201)
  await focus.getByRole('button', { name: '语音设置' }).click()
  await firstVoiceSaved
  await expect.poll(async () => page.evaluate(async (id) => {
    const response = await fetch(`/api/employees/${encodeURIComponent(id)}/dossier`)
    const dossier = await response.json() as { profile?: { voiceProfile?: { voiceId?: string; speed?: number } } }
    return dossier.profile?.voiceProfile
  }, employeeId)).toMatchObject({ voiceId: 'system:voice-zh-a', speed: 1.25 })

  await page.getByRole('button', { name: `与${secondEmployeeName}私聊`, exact: true }).click()
  focus = page.getByRole('region', { name: `${secondEmployeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await expect(twoDimensionalTab).toHaveAttribute('aria-selected', 'true')
  // The 3D control still says what it will do for a character with no avatar,
  // but choosing 3D no longer forces the editor open: the character is in the
  // world either way, as a stand-in until its own avatar exists. Creating one
  // is offered where the character is, in its panel.
  const configureThreeDimensional = page.getByRole('tab', { name: '3D', exact: true })
  await expect(configureThreeDimensional).toBeVisible()
  await focus.getByRole('button', { name: '创建 3D 形象' }).click()
  const avatarDialog = page.getByRole('dialog', { name: `角色设置 · ${secondEmployeeName}` })
  await expect(avatarDialog).toBeVisible()
  const createThreeDimensional = avatarDialog.getByRole('button', { name: '创建 3D 形象', exact: true })
  await expect(createThreeDimensional).toBeFocused()
  await createThreeDimensional.click()
  await expect(avatarDialog.getByText(`创建 ${secondEmployeeName} 的 3D 形象`, { exact: true })).toBeVisible()
  expect(avatarCreationRequests, '只展开创建器时仍不应加载 Provider 或 Worker').toEqual([])
  await avatarDialog.getByRole('radio', { name: /未来/u }).check()
  await avatarDialog.getByRole('radio', { name: '强健', exact: true }).check()
  await avatarDialog.getByRole('radio', { name: '深色', exact: true }).check()
  const generated = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/api/employees/${secondEmployeeId}/avatar-assets`) && response.status() === 201)
  await avatarDialog.getByRole('button', { name: '生成 3D 预览', exact: true }).click()
  await generated
  expect(avatarCreationRequests.some((url) => /procedural-vrm\.worker/iu.test(url)), '确认生成后才加载独立 3D Worker').toBe(true)
  await expect(avatarDialog.getByText('尚未发布')).toBeVisible()
  await expect(avatarDialog.getByText(/自包含 VRM 1.0/u)).toBeVisible()
  const publishedAvatar = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/api/employees/${secondEmployeeId}/avatar-assets/`) && response.url().endsWith('/publish') && response.status() === 201)
  await avatarDialog.getByRole('button', { name: '发布到角色', exact: true }).click()
  await publishedAvatar
  await avatarDialog.getByRole('button', { name: '关闭角色设置' }).click()
  // Publishing an avatar does not move the user: the world was never left, and
  // the 3D control stops offering to create one because the character now has
  // one. Switching to 3D remains the user's choice, not a side effect.
  await expect(page.locator('.world-canvas-host')).toBeVisible()
  await expect(page.getByRole('tablist', { name: '世界显示方式' }).getByRole('tab').nth(1)).toHaveText('3D')
  await twoDimensionalTab.click()
  await expect(twoDimensionalTab).toHaveAttribute('aria-selected', 'true')
  await focus.getByRole('button', { name: '语音设置' }).click()
  await expect(focus.getByLabel('角色声音', { exact: true }).locator('option')).toHaveCount(103)
  await focus.getByLabel('角色声音', { exact: true }).selectOption('system:voice-zh-b')
  await expect(focus.getByRole('slider', { name: '语速' })).toHaveValue('1.1')
  await focus.getByRole('slider', { name: '语速' }).fill('0.9')
  const secondVoiceSaved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/api/employees/') && response.url().endsWith('/profile') && response.status() === 201)
  await focus.getByRole('button', { name: '语音设置' }).click()
  await secondVoiceSaved

  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await focus.getByRole('button', { name: '语音设置' }).click()
  await expect(focus.getByLabel('角色声音', { exact: true })).toHaveValue('system:voice-zh-a')
  await expect(focus.getByRole('slider', { name: '语速' })).toHaveValue('1.25')

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

test('speaks a composer voice turn once in both renderer modes and leaves typed replies silent', async ({ page }) => {
  test.setTimeout(120_000)
  await installVoiceConversationMock(page, '语音模式联合回归')
  const streamRequests: Array<{ text?: string; provider?: string }> = []
  await page.route('**/api/local-tts/models', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ models: [
      { id: 'moss-tts-nano-100m-onnx', provider: 'moss', displayName: 'MOSS-TTS-Nano', version: '100M', license: 'Apache-2.0', byteLength: 1, state: 'not-installed', tier: 'default', recommended: true, runtime: 'onnx-cpu', summary: '测试语音包。' },
      { id: 'kokoro-int8-multi-lang-v1_1', provider: 'kokoro', displayName: 'Kokoro 快速语音', version: '1.1', license: 'Apache-2.0', byteLength: 1, state: 'ready', tier: 'fast', runtime: 'onnx-cpu', summary: '测试备用语音。' },
    ] }),
  }))
  await page.route('**/api/local-tts/stream', async (route) => {
    try { streamRequests.push(JSON.parse(route.request().postData() ?? '{}') as { text?: string; provider?: string }) } catch { streamRequests.push({}) }
    // The focus and composer owners both reach this boundary if ownership is
    // broken. A fast failure is enough to count requests without requiring a
    // real local model or pretending that a microphone/device was verified.
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '测试环境未安装本地语音包' } }) })
  })
  await page.goto(origin)
  runtime.release()
  await page.getByRole('button', { name: `与${employeeName}私聊`, exact: true }).click()
  const focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  await expect(focus).toBeVisible()
  await focus.getByRole('button', { name: '语音设置' }).click()
  await focus.getByLabel('播报模式').selectOption('auto')
  await focus.getByRole('button', { name: '语音设置' }).click()

  const composer = page.locator('.composer-zone')
  const expectedReplyText = `${employeeName} 已完成员工聚焦交互验证。`
  for (const [index, mode] of (['2D', '3D'] as const).entries()) {
    await selectCharacterView(page, mode, employeeName)
    const microphone = composer.getByRole('button', { name: '开始语音对话' })
    await expect(microphone).toBeVisible()
    await microphone.click()
    await expect(composer.getByRole('button', { name: '结束语音对话' })).toBeVisible()
    await expect(page.getByText('语音模式联合回归', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => streamRequests.filter((request) => request.text === expectedReplyText).length).toBe(index + 1)
    await composer.getByRole('button', { name: '结束语音对话' }).click()
    await expect(composer.getByRole('button', { name: '开始语音对话' })).toBeVisible()
  }

  // Turn off the focused panel's independent auto mode so this assertion is
  // specifically about the composer origin. A typed turn must not inherit the
  // preceding voice turn's ownership or generate another TTS request.
  await focus.getByRole('button', { name: '语音设置' }).click()
  await focus.getByLabel('播报模式').selectOption('off')
  await focus.getByRole('button', { name: '语音设置' }).click()
  const beforeTyped = streamRequests.length
  const composerInput = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composerInput.fill('这是键盘输入，不应自动播报')
  await composer.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => runtime.requests.length).toBeGreaterThan(2)
  await page.waitForTimeout(250)
  expect(streamRequests.length, `键盘 turn 不得继承 voice turn 的播报所有权：${JSON.stringify(streamRequests)}`).toBe(beforeTyped)
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

/**
 * Chooses how the world is drawn, then points the camera at somebody.
 *
 * These used to be one control: picking 3D meant looking at one character.
 * They are now separate questions — 2D and 3D are two ways of drawing the same
 * company, and the camera decides who it is on — so getting to a character view
 * means answering both.
 */
async function selectCharacterView(page: Page, mode: '2D' | '3D', expectedEmployeeName: string): Promise<void> {
  // The 3D control names itself after what it will do — "3D" once the
  // The renderer tabs always describe how the world is drawn. Avatar creation
  // is offered by the character panel, not by changing the renderer tab label.
  const display = page.getByRole('tablist', { name: '世界显示方式' })
  const tab = display.getByRole('tab').nth(mode === '2D' ? 0 : 1)
  await expect(tab).toBeVisible()
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const focusCamera = page.getByRole('tab', { name: '聚焦', exact: true })
  await expect(focusCamera).toBeVisible()
  if (await focusCamera.getAttribute('aria-selected') !== 'true') await focusCamera.click()
  await expect(page.getByRole('region', { name: `${expectedEmployeeName}员工聚焦` })).toBeVisible()
}

/**
 * The character is visible somewhere the user can see it.
 *
 * In 2D that is the panel's own sprite stage. In 3D the character stands in
 * the world itself, so the panel deliberately has no stage: one WebGL context
 * draws the whole company, and a second one for the same person is the split
 * this architecture removed.
 */
async function expectCharacterVisible(page: Page, employeeName: string): Promise<void> {
  const focus = page.getByRole('region', { name: `${employeeName}员工聚焦` })
  // Which place is correct depends on the renderer that actually ran, so ask
  // the canvas rather than accepting either. `.or(world-canvas-host)` passed
  // unconditionally — the world canvas is always mounted now — and so proved
  // nothing about the character at all.
  const host = page.locator('.world-canvas-host')
  await expect(host).toBeVisible()
  if (await host.getAttribute('data-renderer-kind') === 'three-3d') {
    await expect(host).toHaveAttribute('data-renderer-kind', 'three-3d')
  } else {
    await expect(focus.locator('.focus-avatar--sprite')).toBeVisible()
  }
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
      speak: (utterance: typeof active & { text?: string; voice?: { voiceURI?: string } | null; rate?: number }) => {
        active = utterance
        ;(window as typeof window & { __dshSpeechLog?: Array<{ text: string; voiceURI: string | null; rate: number }> }).__dshSpeechLog ??= []
        ;(window as typeof window & { __dshSpeechLog: Array<{ text: string; voiceURI: string | null; rate: number }> }).__dshSpeechLog.push({ text: utterance?.text ?? '', voiceURI: utterance?.voice?.voiceURI ?? null, rate: utterance?.rate ?? 1 })
        utterance?.onstart?.()
      },
      cancel: () => { const utterance = active; active = undefined; utterance?.onend?.() },
    } })
    window.setTimeout(() => { loaded = true; for (const listener of listeners) listener() }, 140)
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

async function lastSpokenVoice(page: Page): Promise<string> {
  return page.evaluate(() => {
    const latest = (window as typeof window & { __dshSpeechLog?: Array<{ voiceURI: string | null }> }).__dshSpeechLog?.at(-1)
    return latest?.voiceURI ?? 'system-default'
  })
}

async function lastSpokenText(page: Page): Promise<string> {
  return page.evaluate(() => (window as typeof window & { __dshSpeechLog?: Array<{ text: string }> }).__dshSpeechLog?.at(-1)?.text ?? '')
}

async function lastSpokenRate(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & { __dshSpeechLog?: Array<{ rate: number }> }).__dshSpeechLog?.at(-1)?.rate ?? 0)
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
