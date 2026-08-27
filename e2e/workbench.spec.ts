import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { openDockTab } from './dock-test-helpers.js'

let server: CyberServer
let origin: string
let stateRoot: string

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-e2e-'))
  await mkdir(join(process.cwd(), 'artifacts', 'ui-world-conversations'), { recursive: true })
  await mkdir(join(process.cwd(), 'artifacts', 'settings-experience'), { recursive: true })
  await mkdir(join(process.cwd(), 'artifacts', 'world-market-starter-content'), { recursive: true })
  await mkdir(join(process.cwd(), 'artifacts', 'market-activation-audit'), { recursive: true })
  await mkdir(join(process.cwd(), 'artifacts', 'market-installed-state'), { recursive: true })
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new BrowserRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('onboards, recruits from dossier, talks, browses dossiers and keeps file surfaces hidden', async ({ page }) => {
  await page.goto(origin)

  await expect(page.getByRole('heading', { name: '创建第一个本地世界' })).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: '创建我的世界' }).click()

  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  await expect(page.getByRole('button', { name: '与管家私聊' })).toBeVisible()
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await expect(composer).toBeEnabled()
  await expect(composer).toHaveCount(1)

  await createRoleFromDossier(page, /开发工程师 v1/, '阿帆')
  await expect(composer).toBeEnabled()
  await expect(page.getByRole('button', { name: '与阿帆私聊' })).toBeVisible()
  const sessionRowTops = await page.locator('.session-list .session-row').evaluateAll((rows) =>
    rows.slice(0, 2).map((row) => row.getBoundingClientRect().top),
  )
  expect(sessionRowTops).toHaveLength(2)
  expect(sessionRowTops[1]! - sessionRowTops[0]!).toBeLessThanOrEqual(68)

  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  const engineerCard = dock.getByRole('article').filter({ hasText: '阿帆' })
  await expect(engineerCard).toBeVisible()
  await engineerCard.getByRole('button', { name: /查看角色/ }).click()
  await expect(dock.getByText('阿帆 / 角色')).toBeVisible()
  await dock.getByRole('button', { name: '全部角色' }).click()
  await expect(dock.getByText('角色目录', { exact: true })).toBeVisible()
  await expect(dock.getByRole('article').filter({ hasText: '阿帆' })).toBeVisible()

  await composer.fill('@阿帆 请确认真实回合')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('我先建立性能基线。').first()).toBeVisible()
  await openDockTab(dock, '轨迹')
  const completedTrace = dock.locator('.world-trace-item').filter({ hasText: '完成处理' }).filter({ hasText: '阿帆' }).first()
  await expect(completedTrace).toBeVisible()
  await completedTrace.locator('summary').click()
  await expect(completedTrace.locator('.world-trace-item__detail')).toContainText('核对事实与权限。')
  await expect(completedTrace.locator('.world-trace-item__detail')).toContainText('search_workspace')
  await expect(page.getByText('阿帆的思考过程')).toHaveCount(0)

  const localWorkspace = server.store.listWorkspaces()[0]!
  const localWorld = server.store.listWorlds(localWorkspace.id)[0]!
  const worldFilesRoot = join(stateRoot, 'worlds', encodeURIComponent(localWorld.id), 'files')
  await mkdir(join(worldFilesRoot, 'docs'), { recursive: true })
  await writeFile(join(worldFilesRoot, 'docs', 'hello.md'), '# 当前世界文件\n', 'utf8')
  const fileListing = await (await fetch(`${origin}/api/worlds/${localWorld.id}/files?path=docs`)).json() as { items: Array<{ name: string }> }
  expect(fileListing.items.map((item) => item.name)).toContain('hello.md')
  expect(await (await fetch(`${origin}/api/worlds/${localWorld.id}/file?path=docs%2Fhello.md`)).text()).toContain('当前世界文件')
  await expect(dock.getByRole('button', { name: '文件', exact: true })).toHaveCount(0)
  await expect(dock.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)

  await expect(page.locator('.composer')).toHaveCount(1)
  await expect(page.locator('.workbench-shell')).toBeVisible()
})

test('opens low-frequency dock surfaces from More as closable restored tabs', async ({ page }) => {
  const consoleIssues: string[] = []
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(`[${message.type()}] ${message.text()}`) })
  page.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`))
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  if (await onboarding.isVisible()) await page.getByRole('button', { name: '创建我的世界' }).click()
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  const more = dock.getByRole('button', { name: '更多', exact: true })

  await expect(dock.getByRole('tab', { name: '世界', exact: true })).toBeVisible()
  await expect(dock.getByRole('tab', { name: '轨迹', exact: true })).toBeVisible()
  for (const label of ['角色', '任务', '知识', '产物', '日程']) await expect(dock.getByRole('tab', { name: label, exact: true })).toHaveCount(0)

  await more.click()
  const menu = dock.getByRole('menu', { name: '更多', exact: true })
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['角色', '任务', '知识', '产物', '日程'])
  await menu.getByRole('menuitemcheckbox', { name: '知识', exact: true }).click()
  await expect(dock.getByRole('tab', { name: '知识', exact: true })).toBeVisible()
  await openDockTab(dock, '日程')
  await expect(dock.getByRole('tab', { name: '日程', exact: true })).toHaveAttribute('aria-selected', 'true')

  await dock.getByRole('button', { name: '关闭知识页签' }).click()
  await expect(dock.getByRole('tab', { name: '知识', exact: true })).toHaveCount(0)
  await openDockTab(dock, '角色')
  await dock.getByRole('button', { name: '关闭角色页签' }).click()
  await expect(dock.getByRole('tab', { name: '日程', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: '任务日程' })).toBeVisible()

  await page.reload()
  const restoredDock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await expect(restoredDock.getByRole('tab', { name: '日程', exact: true })).toBeVisible()
  await expect(restoredDock.getByRole('tab', { name: '知识', exact: true })).toHaveCount(0)
  await expect(restoredDock.getByRole('tab', { name: '角色', exact: true })).toHaveCount(0)

  const restoredMore = restoredDock.getByRole('button', { name: '更多', exact: true })
  await restoredMore.click()
  await restoredMore.press('Escape')
  await expect(restoredMore).toBeFocused()
  for (const viewport of [{ width: 1_440, height: 900, label: '1440x900' }, { width: 1_920, height: 1_080, label: '1920x1080' }, { width: 3_840, height: 2_160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    await restoredMore.click()
    expect(await restoredDock.locator('.dock-tabs').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await restoredDock.locator('.dock-tabs').evaluate((element) => Array.from(element.querySelectorAll('button, span')).every((item) => Number.parseFloat(getComputedStyle(item).fontSize) >= 12))).toBe(true)
    await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', `dynamic-dock-tabs-${viewport.label}.png`) })
    await restoredMore.click()
  }
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

test('keeps world sessions and message history isolated when world requests finish out of order', async ({ page }) => {
  const liveRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/worlds\/[^/]+\/(?:live|stream)(?:\?|$)/.test(request.url())) liveRequests.push(request.url())
  })
  const workspace = server.store.listWorkspaces()[0] ?? server.store.createWorkspace({ name: '世界隔离测试工作区' })
  const returnWorld = server.store.listWorlds(workspace.id)[0]
  const createWorld = async (name: string, employeeName: string, historyText: string) => {
    const worldResponse = await fetch(`${origin}/api/workspaces/${workspace.id}/worlds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, templateId: 'personal-world' }),
    })
    expect(worldResponse.status).toBe(201)
    const { world } = await worldResponse.json() as { world: { id: string; name: string } }
    const recruitResponse = await fetch(`${origin}/api/worlds/${world.id}/recruit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprintId: 'core.butler', blueprintVersion: 1, displayName: employeeName }),
    })
    expect(recruitResponse.status).toBe(201)
    const { employee } = await recruitResponse.json() as { employee: { id: string } }
    const session = server.store.listSessions(world.id)[0]!
    server.store.appendMessage({
      sessionId: session.id,
      senderId: 'owner',
      senderKind: 'owner',
      kind: 'user',
      content: `${historyText}·用户`,
    })
    server.store.appendMessage({
      sessionId: session.id,
      senderId: employee.id,
      senderKind: 'employee',
      kind: 'assistant',
      content: `${historyText}·角色`,
    })
    return { world, employeeName, employeeId: employee.id, sessionId: session.id, historyText }
  }

  const slowWorld = await createWorld('竞态世界甲', '甲世界管家', '甲世界历史')
  const targetWorld = await createWorld('竞态世界乙', '乙世界管家', '乙世界历史')
  const secondRecruitResponse = await fetch(`${origin}/api/worlds/${targetWorld.world.id}/recruit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blueprintId: 'core.butler', blueprintVersion: 1, displayName: '乙世界工程师' }),
  })
  expect(secondRecruitResponse.status).toBe(201)
  const { employee: secondEmployee } = await secondRecruitResponse.json() as { employee: { id: string } }
  const secondSession = server.store.listSessions(targetWorld.world.id)
    .find((session) => server.store.listParticipants(session.id).some((participant) => participant.participantId === secondEmployee.id))!
  server.store.appendMessage({
    sessionId: secondSession.id,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content: '乙世界工程师历史·用户',
  })
  server.store.appendMessage({
    sessionId: secondSession.id,
    senderId: secondEmployee.id,
    senderKind: 'employee',
    kind: 'assistant',
    content: '乙世界工程师历史·角色',
  })
  await page.route(`**/api/worlds/${slowWorld.world.id}/snapshot`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
  await page.route(`**/api/sessions/${targetWorld.sessionId}/messages?*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByLabel(/切换世界，当前为/).click()
  await page.getByRole('menuitemradio', { name: new RegExp(slowWorld.world.name) }).click()
  await page.getByLabel(new RegExp(`切换世界，当前为${slowWorld.world.name}`)).click()
  await page.getByRole('menuitemradio', { name: new RegExp(targetWorld.world.name) }).click()

  await expect(page.getByLabel(new RegExp(`切换世界，当前为${targetWorld.world.name}`))).toBeVisible()
  await expect(page.getByRole('button', { name: `与${targetWorld.employeeName}私聊` })).toBeVisible()
  await expect(page.getByRole('button', { name: `与${slowWorld.employeeName}私聊` })).toHaveCount(0)
  await page.getByRole('button', { name: `与${targetWorld.employeeName}私聊` }).click()
  const chat = page.getByRole('region', { name: '当前世界多角色会话' })
  await page.getByRole('button', { name: '与乙世界工程师私聊' }).click()
  await expect(chat.getByRole('heading', { name: '乙世界工程师', exact: true })).toBeVisible()
  await expect(chat.getByText('乙世界工程师历史·用户', { exact: true })).toBeVisible()
  await expect(chat.getByText('乙世界工程师历史·角色', { exact: true })).toBeVisible()
  await expect(chat.getByText(`${targetWorld.historyText}·角色`, { exact: true })).toHaveCount(0)
  await page.waitForTimeout(900)
  await expect(chat.getByRole('heading', { name: '乙世界工程师', exact: true })).toBeVisible()
  await expect(chat.getByText('乙世界工程师历史·角色', { exact: true })).toBeVisible()
  await expect(chat.getByText(`${targetWorld.historyText}·角色`, { exact: true })).toHaveCount(0)
  const targetSharedLiveRequests = liveRequests.filter((url) => url.includes(`/api/worlds/${targetWorld.world.id}/live`)).length
  await page.evaluate(async (worldId) => {
    const streams = Array.from({ length: 4 }, () => new EventSource(`/api/worlds/${encodeURIComponent(worldId)}/live`))
    await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
      stream.onopen = () => resolve()
    })))
    ;(window as typeof window & { __historyConnectionPressure?: EventSource[] }).__historyConnectionPressure = streams
  }, targetWorld.world.id)
  await chat.getByRole('button', { name: '查看历史消息' }).click()
  const history = page.getByRole('dialog', { name: '历史消息' })
  await expect(history.getByText('正在加载历史消息…')).toBeHidden()
  await expect(history.getByText('共 2 条可查看消息')).toBeVisible()
  await expect(history.getByText('乙世界工程师历史·用户', { exact: true })).toBeVisible()
  await expect(history.getByText('乙世界工程师历史·角色', { exact: true })).toBeVisible()
  await history.getByRole('button', { name: '关闭历史消息' }).click()
  await page.evaluate(() => {
    const target = window as typeof window & { __historyConnectionPressure?: EventSource[] }
    target.__historyConnectionPressure?.forEach((stream) => stream.close())
    delete target.__historyConnectionPressure
  })

  await page.waitForTimeout(1_000)
  await expect(page.getByLabel(new RegExp(`切换世界，当前为${targetWorld.world.name}`))).toBeVisible()
  await expect(page.getByRole('button', { name: `与${targetWorld.employeeName}私聊` })).toBeVisible()
  await expect(page.getByRole('button', { name: `与${slowWorld.employeeName}私聊` })).toHaveCount(0)
  await expect(chat.getByText('乙世界工程师历史·角色', { exact: true })).toBeVisible()

  await page.unroute(`**/api/worlds/${slowWorld.world.id}/snapshot`)
  await page.unroute(`**/api/sessions/${targetWorld.sessionId}/messages?*`)
  await page.getByLabel(new RegExp(`切换世界，当前为${targetWorld.world.name}`)).click()
  await page.getByRole('menuitemradio', { name: new RegExp(slowWorld.world.name) }).click()
  await expect(page.getByRole('button', { name: `与${slowWorld.employeeName}私聊` })).toBeVisible()
  await page.getByRole('button', { name: `与${slowWorld.employeeName}私聊` }).click()
  await expect(chat.getByText(`${slowWorld.historyText}·用户`, { exact: true })).toBeVisible()
  await expect(chat.getByText(`${slowWorld.historyText}·角色`, { exact: true })).toBeVisible()
  await expect(chat.getByText(`${targetWorld.historyText}·角色`, { exact: true })).toHaveCount(0)

  if (returnWorld !== undefined && returnWorld.id !== slowWorld.world.id) {
    await page.getByLabel(new RegExp(`切换世界，当前为${slowWorld.world.name}`)).click()
    await page.getByRole('menuitemradio', { name: new RegExp(returnWorld.name) }).click()
    await expect(page.getByLabel(new RegExp(`切换世界，当前为${returnWorld.name}`))).toBeVisible()
  }
  expect(liveRequests.filter((url) => /\/stream(?:\?|$)/.test(url))).toEqual([])
  expect(targetSharedLiveRequests).toBe(1)
})

test('runs direct and group conversations with real world lifecycle, persistence, and reconnect recovery', async ({ page }) => {
  await page.goto(origin)
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
  }
  await expect(shell).toBeVisible()
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()

  if (await page.getByRole('button', { name: '与阿帆私聊' }).count() === 0) {
    await createRoleFromDossier(page, /开发工程师 v1/, '阿帆')
  }
  await createRoleFromDossier(page, /秘书 v1/, '小周')

  const snapshotResponse = await fetch(`${origin}/api/workspaces`)
  const workspaces = await snapshotResponse.json() as { items: Array<{ id: string }> }
  const workspaceSnapshot = await (await fetch(`${origin}/api/workspaces/${workspaces.items[0]!.id}/snapshot`)).json() as { worlds: Array<{ id: string }> }
  const worldId = workspaceSnapshot.worlds[0]!.id
  const worldSnapshot = await (await fetch(`${origin}/api/worlds/${worldId}/snapshot`)).json() as { employees: Array<{ id: string; displayName: string }> }
  const engineer = worldSnapshot.employees.find((employee) => employee.displayName === '阿帆')!
  const product = worldSnapshot.employees.find((employee) => employee.displayName === '小周')!

  const taskStartedBeforeIntent = server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.started').length
  await page.getByRole('button', { name: '与阿帆私聊' }).click()
  await expect(page.getByRole('heading', { name: '阿帆', exact: true })).toBeVisible()
  await expect(page.getByLabel('当前会话成员')).toContainText('阿帆')
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  expect(server.store.getEmployee(engineer.id)?.status).toBe('available')
  expect(server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.started')).toHaveLength(taskStartedBeforeIntent)
  await openDockTab(dock, '角色')
  expect(server.store.getEmployee(engineer.id)?.status).toBe('available')
  expect(server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.started')).toHaveLength(taskStartedBeforeIntent)

  const taskCompletedBeforeSubmit = server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.completed').length
  await openDockTab(dock, '世界')
  await page.getByRole('button', { name: '与阿帆私聊' }).click()
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  const persistedReplies = page.locator('.message__content').getByText('我先建立性能基线。', { exact: true })
  const persistedReplyCountBeforeSubmit = await persistedReplies.count()
  await composer.fill('任务：实现可恢复的世界状态')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(persistedReplies).toHaveCount(persistedReplyCountBeforeSubmit + 1)
  await expect(persistedReplies.last()).toBeVisible()
  await expect.poll(() => server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.completed').length).toBeGreaterThan(taskCompletedBeforeSubmit)
  const taskEvents = server.store.listWorldDomainEvents(worldId)
  expect(taskEvents.filter((event) => event.type === 'task.started').length).toBeGreaterThan(taskStartedBeforeIntent)
  expect(server.store.getEmployee(engineer.id)?.status).toBe('available')

  await openDockTab(dock, '角色')
  await dock.getByRole('article').filter({ hasText: '阿帆' }).getByRole('button', { name: /查看角色/ }).click()
  await dock.getByRole('button', { name: '事迹', exact: true }).click()
  await expect(dock.getByText(/完成任务：任务：实现可恢复的世界状态/).first()).toBeVisible()
  await expect(dock.getByText(/search_workspace/).first()).toBeVisible()
  await dock.getByRole('button', { name: '日志', exact: true }).click()
  await expect(dock.getByText(/当日参与 \d+ 轮交流与任务/)).toBeVisible()
  await openDockTab(dock, '世界')

  const meetingStartedBefore = server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'meeting.started').length
  await page.getByRole('button', { name: '创建群聊' }).click()
  const groupDialog = page.getByRole('dialog', { name: '创建群聊' })
  await groupDialog.getByRole('checkbox', { name: /阿帆/ }).check()
  await groupDialog.getByRole('checkbox', { name: /小周/ }).check()
  await groupDialog.getByRole('textbox', { name: '群聊名称' }).fill('世界运行时联席会')
  await groupDialog.getByRole('button', { name: '创建群聊', exact: true }).click()
  await expect(groupDialog).toBeHidden()
  expect(server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'meeting.started')).toHaveLength(meetingStartedBefore)
  expect(server.store.getEmployee(engineer.id)?.status).toBe('available')
  expect(server.store.getEmployee(product.id)?.status).toBe('available')
  await expect(page.getByRole('heading', { name: '世界运行时联席会' })).toBeVisible()
  await expect(page.getByLabel('当前会话成员')).toContainText('阿帆、小周')
  await composer.fill('请召开真实多人会议，依次汇报恢复方案。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(() => server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'meeting.finished').length).toBeGreaterThan(0)
  const meetingEvents = server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'meeting.started')
  expect(meetingEvents).toHaveLength(meetingStartedBefore + 1)
  const latestMeeting = meetingEvents.at(-1)!
  expect(latestMeeting.payload.participantIds).toEqual([engineer.id, product.id])
  const groupSession = server.store.listSessions(worldId).find((session) => session.kind === 'group')!
  expect(server.store.listMessages(groupSession.id).filter((message) => message.kind === 'assistant').map((message) => message.senderId)).toEqual([engineer.id, product.id])

  const evidenceEvent = server.store.listWorldDomainEvents(worldId).find((event) => event.type === 'task.completed')!
  for (const category of ['skill', 'delivery', 'promotion'] as const) {
    server.store.appendEmployeeMilestone({
      employeeId: engineer.id,
      category,
      title: `${category} 里程碑`,
      summary: '由真实任务交付与事件证据生成。',
      sourceEventIds: [evidenceEvent.id],
    })
  }

  const lightButton = page.getByRole('button', { name: '关闭场景照明' })
  await lightButton.click()
  await expect(page.getByRole('button', { name: '打开场景照明' })).toBeVisible()
  const beforeRestart = await (await fetch(`${origin}/api/worlds/${worldId}/runtime-snapshot`)).json() as { entities: unknown[]; growthSlots: Record<string, string[]>; clock: { lightsOn: boolean } }
  expect(beforeRestart.clock.lightsOn).toBe(false)
  expect(beforeRestart.growthSlots.skill).toHaveLength(1)
  expect(beforeRestart.growthSlots.delivery).toHaveLength(1)
  expect(beforeRestart.growthSlots.promotion).toHaveLength(1)
  const eventCountBeforeReload = server.store.listWorldDomainEvents(worldId).length
  await page.reload()
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  expect(server.store.listWorldDomainEvents(worldId)).toHaveLength(eventCountBeforeReload)

  await server.close()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new BrowserRuntime(),
  })
  origin = (await server.start()).origin
  await page.goto(origin)
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  await expect(page.getByRole('button', { name: '打开场景照明' })).toBeVisible()
  const afterRestart = await (await fetch(`${origin}/api/worlds/${worldId}/runtime-snapshot`)).json() as typeof beforeRestart
  expect(afterRestart.entities).toEqual(beforeRestart.entities)
  expect(afterRestart.growthSlots).toEqual(beforeRestart.growthSlots)

  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('button', { name: '与阿帆私聊' }).click()
  await expect(page.getByText('我先建立性能基线。').first()).toBeVisible()
  await openDockTab(dock, '角色')
  await expect(dock.getByText('角色目录', { exact: true })).toBeVisible()
  await expect(dock.getByRole('button', { name: '文件', exact: true })).toHaveCount(0)
  await expect(dock.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)
})

test('creates a durable safe schedule, runs it once, and restores it after reload', async ({ page }) => {
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
    await expect(page.locator('.workbench-shell')).toBeVisible()
  }
  const scheduleDock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(scheduleDock, '日程')
  const panel = page.getByRole('region', { name: '任务日程' })
  await panel.getByRole('button', { name: '新建日程' }).first().click()
  await expect(panel.getByLabel('日程名称')).toBeFocused()
  await panel.getByRole('button', { name: '保存日程' }).click()
  await expect(panel.getByText('请填写便于识别的日程名称。')).toBeVisible()
  await expect(panel.getByLabel(/日程名称/)).toBeFocused()
  await panel.getByLabel(/日程名称/).fill('E2E 每日交付摘要')
  await panel.getByLabel('任务内容').fill('任务：汇总今日交付并给出下一步。')
  await panel.getByRole('radio', { name: /世界内读写/ }).check()
  await panel.getByRole('button', { name: '保存日程' }).click()
  await expect(panel.getByText('E2E 每日交付摘要')).toBeVisible()
  await expect(panel.getByText('世界内读写', { exact: true })).toBeVisible()

  await page.reload()
  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '日程')
  const restored = page.getByRole('region', { name: '任务日程' }).getByText('E2E 每日交付摘要')
  await expect(restored).toBeVisible()
  const scheduleRow = page.getByRole('region', { name: '任务日程' }).locator('li').filter({ hasText: 'E2E 每日交付摘要' })
  await scheduleRow.getByRole('button', { name: '立即运行' }).click()
  await expect(scheduleRow.getByText('已完成', { exact: true })).toBeVisible()
  await expect.poll(() => server.store.database.prepare("SELECT COUNT(*) AS count FROM task_schedule_runs WHERE status = 'completed'").get() as { count: number }).toMatchObject({ count: 1 })
})

test('keeps the workbench readable and the world viewport filled on a 4K display', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.goto(origin)
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
  }
  await expect(shell).toBeVisible()
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })

  const left = await page.locator('.left-pane').boundingBox()
  const center = await page.locator('.center-pane').boundingBox()
  const right = await page.locator('.right-pane').boundingBox()

  expect(left?.width ?? 0).toBeGreaterThan(330)
  expect(center?.width ?? 0).toBeGreaterThan(1_200)
  expect(right?.width ?? 0).toBeGreaterThan(700)
  await expect(dock.locator('.world-activity-rail')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '给当前世界的角色发送消息' })).toHaveCount(1)

  const stage = await page.locator('.world-runtime-dock__canvas').boundingBox()
  const canvas = await page.locator('.world-canvas-host').boundingBox()
  expect(Math.abs((stage?.height ?? 0) - (canvas?.height ?? 0))).toBeLessThan(3)
  expect(stage?.height ?? 0).toBeGreaterThan((right?.height ?? 0) * 0.8)
  expect(stage?.width ?? 0).toBeGreaterThan(800)
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-3840x2160.png') })

  const sharedWidth = (await page.locator('.right-pane').boundingBox())?.width ?? 0
  await openDockTab(dock, '角色')
  expect(Math.abs(((await page.locator('.right-pane').boundingBox())?.width ?? 0) - sharedWidth)).toBeLessThan(2)
  await expect(dock.getByRole('button', { name: '文件', exact: true })).toHaveCount(0)
  await expect(dock.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)
  await openDockTab(dock, '世界')

  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-1920x1080.png') })

  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-1440x900.png') })
  for (let index = 0; index < 20; index += 1) {
    await openDockTab(dock, '角色')
    await expect(page.locator('.world-runtime-canvas')).toHaveCount(0)
    await openDockTab(dock, '世界')
    await expect(page.locator('.world-runtime-canvas')).toHaveCount(1)
  }
})

test('creates, edits, restores, and deletes a private-network sub2api model profile', async ({ page }) => {
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.route('**/api/workspaces/*/model-profiles/discover', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.5:9b' }, { id: 'qwen3.5' }] }),
    })
  })
  await page.goto(origin)
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
  }
  await expect(shell).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  let settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings.getByText('常用设置', { exact: true })).toBeVisible()
  await expect(settings.getByText('数据与记录', { exact: true })).toBeVisible()
  await expect(settings.getByText('高级', { exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: '运行时', exact: true })).toHaveCount(0)
  await expect(settings.getByRole('button', { name: '本地数据', exact: true })).toHaveCount(0)
  await settings.getByRole('button', { name: /AI 模型/ }).click()
  await expect(settings.getByRole('heading', { name: 'AI 模型' })).toBeVisible()
  await expect(settings.getByText('每个模型连接单独保存，密钥不会显示在页面中')).toBeVisible()
  await expect(settings.getByText('温度', { exact: false })).toHaveCount(0)

  await settings.getByRole('button', { name: '连接模型', exact: true }).click()
  const editor = settings.getByRole('form', { name: '模型连接编辑器' })
  await editor.getByRole('combobox', { name: '模型服务' }).selectOption('custom-local')
  await editor.getByRole('textbox', { name: '连接名称' }).fill('公司 sub2api')
  await editor.getByRole('textbox', { name: '服务地址' }).fill('http://172.16.1.125:11434/v1/')
  const apiKey = editor.locator('input[type="password"]')
  const manualModelId = editor.getByLabel('模型 ID')
  await apiKey.fill('sk-e2e-test-only-not-real')
  expect((await apiKey.boundingBox())!.y).toBeLessThan((await manualModelId.boundingBox())!.y)
  await manualModelId.fill('qwen3.5:9b')
  const advancedConnection = editor.locator('details').filter({ hasText: '高级连接设置' })
  await expect(advancedConnection).not.toHaveAttribute('open', '')
  await expect(editor.getByRole('combobox', { name: '接口兼容方式' })).not.toBeVisible()
  await advancedConnection.locator('summary').click()
  await expect(editor.getByRole('combobox', { name: '接口兼容方式' })).toBeVisible()
  await editor.getByRole('checkbox', { name: /启用联网搜索/ }).check()
  await editor.getByRole('textbox', { name: /搜索服务地址/ }).fill('https://search.example.test/anthropic/v1')
  await editor.getByRole('button', { name: '获取可用模型' }).click()
  const modelSearch = editor.getByRole('combobox', { name: '搜索并选择可用模型' })
  await expect(modelSearch).toBeVisible()
  await expect(modelSearch).toHaveValue('qwen3.5:9b')
  await modelSearch.fill('qwen3.5:9b')
  await editor.getByRole('option', { name: 'qwen3.5:9b', exact: true }).click()
  await editor.getByRole('button', { name: '手动填写其他模型 ID' }).click()
  await expect(editor.getByLabel('模型 ID')).toBeVisible()
  await editor.getByRole('button', { name: '从已获取列表选择' }).click()
  await expect(modelSearch).toHaveValue('qwen3.5:9b')
  await editor.getByRole('button', { name: '添加并保存' }).click()
  await expect(editor.getByRole('status')).toContainText('模型已连接并保存')
  await expect(settings.getByRole('article').filter({ hasText: '公司 sub2api' })).toContainText('联网搜索已启用')

  await settings.getByRole('button', { name: '编辑公司 sub2api' }).click()
  await editor.getByLabel('模型 ID').fill('qwen3.5')
  await editor.getByRole('button', { name: '保存修改' }).click()
  await expect(editor.getByRole('status')).toContainText('模型连接已更新')
  await expect(settings.getByRole('article').filter({ hasText: '公司 sub2api' })).toContainText('qwen3.5')

  await server.close()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new BrowserRuntime(),
  })
  origin = (await server.start()).origin
  await page.goto(origin)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: /AI 模型/ }).click()
  const restored = settings.getByRole('article').filter({ hasText: '公司 sub2api' })
  await expect(restored).toContainText('qwen3.5')
  await expect(restored).toContainText('API 密钥已保存')
  await expect(restored).toContainText('联网搜索已启用')
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'settings-experience', 'model-settings-1920x1080.png') })
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'settings-experience', 'model-settings-1440x900.png') })
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'settings-experience', 'model-settings-3840x2160.png') })
  await page.setViewportSize({ width: 1_920, height: 1_080 })

  page.once('dialog', (dialog) => dialog.accept())
  await settings.getByRole('button', { name: '删除公司 sub2api' }).click()
  await expect(settings.getByText('还没有连接模型')).toBeVisible()
  await expect(settings.getByText('模型连接已删除')).toBeVisible()
})

test('discovers, installs, and creates a visually distinct world from the world-first market', async ({ page }) => {
  test.setTimeout(90_000)
  const consoleEntries: string[] = []
  const pageErrors: string[] = []
  const failedResponses: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleEntries.push(`[${message.type()}] ${message.text()} ${message.location().url}`)
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  // Same guard as every other entry point: isVisible() does not wait, so
  // without it the onboarding click is skipped whenever the bundle takes a
  // moment longer to hydrate.
  await expect(page.locator('.workbench-shell').or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) await page.getByRole('button', { name: '创建我的世界' }).click()

  await page.getByRole('button', { name: '市场', exact: true }).click()
  const market = page.getByRole('dialog', { name: '扩展市场' })
  await expect(market).toBeVisible()
  await expect(market.locator('.market-tabs button')).toHaveText(['世界', '角色', '插件', '皮肤'])
  for (const worldName of ['赛博公司', '月影酒馆', '云端创作工坊', '远星观测站']) {
    await expect(market.locator('.market-card-grid > article').filter({ hasText: worldName })).toBeVisible()
  }
  const cyberCard = market.locator('.market-card-grid > article').filter({ hasText: '赛博公司' })
  await expect(cyberCard).toContainText('已内置 · 当前可用')
  await expect(cyberCard.getByRole('button', { name: '已内置' })).toBeDisabled()
  const covers = market.locator('.market-world-cover')
  await expect(covers).toHaveCount(4)
  expect(await covers.evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 1_000))).toBe(true)
  const cardParagraphSize = await market.locator('.market-card-grid article > p').first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
  expect(cardParagraphSize).toBeGreaterThanOrEqual(14)
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'world-market-starter-content', 'market-1920x1080.png') })
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'world-market-starter-content', 'market-1440x900.png') })
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'world-market-starter-content', 'market-3840x2160.png') })
  await page.setViewportSize({ width: 1_920, height: 1_080 })

  const tavernCard = market.locator('.market-card-grid > article').filter({ hasText: '月影酒馆' })
  await tavernCard.getByRole('button', { name: '查看并安装' }).click()
  await market.getByRole('checkbox', { name: /我已审阅发布者/ }).check()
  await market.getByRole('button', { name: /批准安装/ }).click()
  await expect(tavernCard).toContainText('已安装 v1.0.0 · 可创建')
  await expect(tavernCard.getByRole('button', { name: '创建新世界' })).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'market-installed-state', 'installed-worlds-1920x1080.png') })
  await tavernCard.getByRole('button', { name: '创建新世界' }).click()
  await expect(market.getByRole('heading', { name: /月影酒馆/ })).toBeVisible()
  await market.getByRole('textbox', { name: '新世界名称' }).fill('月影酒馆 E2E')
  await market.getByRole('button', { name: '创建并进入这个世界' }).click()
  await expect(market).toBeHidden()
  await expect(page.getByLabel('月影酒馆 E2E实时世界')).toBeVisible()
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(page.locator('.world-runtime-canvas')).toBeVisible()
    const panel = await page.locator('.right-pane').boundingBox()
    const canvas = await page.locator('.world-canvas-host').boundingBox()
    expect(canvas?.width ?? 0).toBeGreaterThan((panel?.width ?? 0) * 0.9)
    expect(canvas?.height ?? 0).toBeGreaterThan((panel?.height ?? 0) * 0.78)
    await page.screenshot({ path: join(process.cwd(), 'artifacts', 'world-market-starter-content', `tavern-world-${viewport.label}.png`) })
  }
  await page.setViewportSize({ width: 1_920, height: 1_080 })

  const workspace = server.store.listWorkspaces()[0]!
  const created = server.store.listWorlds(workspace.id).find((world) => world.name === '月影酒馆 E2E')!
  expect(created.templateId).toBe('tavern')
  expect(server.store.listEmployees(created.id).map((employee) => employee.displayName).sort()).toEqual(['吟游诗人', '酒馆老板', '远行制图师'].sort())
  expect(server.store.getWorldThemeBinding(created.id)).toMatchObject({ packageId: 'official-moonlit-tavern', status: 'active' })

  await page.getByRole('button', { name: '市场', exact: true }).click()
  await market.getByRole('button', { name: '角色', exact: true }).click()
  for (const roleName of ['档案管理员', '织梦说书人', '视觉导演', '异星生态学家']) {
    await expect(market.locator('.market-card-grid > article').filter({ hasText: roleName })).toBeVisible()
  }
  const roleCovers = market.locator('.market-role-cover')
  expect(await roleCovers.count()).toBeGreaterThanOrEqual(4)
  for (let index = 0; index < await roleCovers.count(); index += 1) {
    await roleCovers.nth(index).scrollIntoViewIfNeeded()
    await expect.poll(() => roleCovers.nth(index).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  }
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'world-market-starter-content', 'roles-1920x1080.png') })

  const storytellerCard = market.locator('.market-card-grid > article').filter({ hasText: '织梦说书人' })
  await storytellerCard.getByRole('button', { name: '查看并安装' }).click()
  await market.getByRole('checkbox', { name: /我已审阅发布者/ }).check()
  await market.getByRole('button', { name: /批准安装/ }).click()
  await expect(storytellerCard.getByRole('button', { name: '招募到世界' })).toBeVisible()
  await storytellerCard.getByRole('button', { name: '招募到世界' }).click()
  await expect(market.getByText('角色模板已安装')).toBeVisible()
  await expect(market.getByText('与当前世界兼容')).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'market-activation-audit', 'role-ready-1920x1080.png') })
  await market.getByRole('button', { name: '选择名字与权限' }).click()
  await expect(market).toBeHidden()

  const recruitment = page.getByRole('dialog', { name: '邀请角色' })
  await expect(recruitment).toBeVisible()
  await expect(recruitment.getByRole('button', { name: /织梦说书人/ })).toHaveClass(/is-active/)
  await recruitment.getByRole('textbox', { name: '角色名字（可选）' }).fill('夜航说书人')
  await recruitment.getByRole('button', { name: /邀请角色入场|确认新增|再创建一名/ }).click()
  await expect(recruitment).toBeHidden()
  await expect(page.getByRole('button', { name: '与夜航说书人私聊' })).toBeVisible()

  await page.getByRole('button', { name: '市场', exact: true }).click()
  await market.getByRole('button', { name: '插件', exact: true }).click()
  for (const pluginName of ['会议纪要助手', '研究简报', '决策记录', '发布检查']) {
    await expect(market.locator('.market-card-grid > article').filter({ hasText: pluginName })).toBeVisible()
  }
  await expect(market.getByText(/按世界启用/).first()).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'world-market-starter-content', 'plugins-1920x1080.png') })

  const researchCard = market.locator('.market-card-grid > article').filter({ hasText: '研究简报' })
  await researchCard.getByRole('button', { name: '查看并安装' }).click()
  await market.getByRole('checkbox', { name: /我已审阅发布者/ }).check()
  await market.getByRole('button', { name: /批准安装/ }).click()
  await expect(researchCard.getByRole('button', { name: '立即使用' })).toBeVisible()
  await researchCard.getByRole('button', { name: '立即使用' }).click()
  await expect(market.getByText('插件已安装 · 所有世界可用')).toBeVisible()
  await expect(market.getByText('/research-brief', { exact: true })).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'market-activation-audit', 'plugin-ready-1920x1080.png') })
  await market.getByRole('button', { name: /带入对话/ }).click()
  await expect(market).toBeHidden()
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await expect(composer).toHaveValue('/research-brief ')
  await expect(composer).toBeFocused()

  await writeFile(
    join(process.cwd(), 'artifacts', 'world-market-starter-content', 'console.log'),
    `[pageerror]\n${pageErrors.join('\n')}\n\n[console]\n${consoleEntries.join('\n')}\n\n[http]\n${failedResponses.join('\n')}\n`,
    'utf8',
  )
  expect(pageErrors).toEqual([])
  expect(failedResponses).toEqual([])
  expect(consoleEntries).toEqual([])
})

test('opens the dossier as an all-employee information directory', async ({ page }) => {
  await page.goto(`${origin}?demo=1`)
  await page.getByLabel(/切换世界，当前为/).click()
  await page.getByRole('menuitemradio', { name: /月影酒馆/ }).click()
  await expect(page.getByLabel('月影酒馆实时世界')).toBeVisible()
  await expect(page.getByRole('button', { name: '与伊瑟拉私聊' })).toBeVisible()
  await page.getByLabel(/切换世界，当前为月影酒馆/).click()
  await page.getByRole('menuitemradio', { name: /赛博公司/ }).click()
  await page.getByLabel(/切换世界，当前为赛博公司/).click()
  await page.getByRole('button', { name: /探索更多世界/ }).click()
  const themeMarket = page.getByRole('dialog', { name: '扩展市场' })
  await expect(themeMarket.getByRole('button', { name: '世界', exact: true })).toBeVisible()
  await themeMarket.getByRole('button', { name: '关闭市场' }).click()
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')

  await expect(dock.getByText('角色目录')).toBeVisible()
  await expect(dock.getByText('8 名角色')).toBeVisible()
  await expect(dock.getByRole('article')).toHaveCount(8)
  for (const employee of ['小羽', '老周', '阿帆', '小Q', '安澜', '墨游', '小E', '秘书']) {
    await expect(dock.getByRole('article').filter({ hasText: employee })).toBeVisible()
  }
  await expect(dock.getByText('8', { exact: true }).first()).toBeVisible()
  await expect(dock.getByText('32', { exact: true })).toBeVisible()
})

test('keeps chat conversational while World Trace explains execution during and after a turn', async ({ page }) => {
  test.setTimeout(90_000)
  // 用慢速回合重建 server，留出窗口断言“进行中”状态
  await server.close()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new BrowserRuntime({ eventIntervalMs: 500 }),
  })
  origin = (await server.start()).origin
  const consoleEntries: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleEntries.push(`[${message.type()}] ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.goto(origin)
  // 独立于测试 1/2：无工作区则自行 onboarding，已有则直接进入
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
    await expect(shell).toBeVisible()
  }

  // 无“与阿帆私聊”则自行招募，已有则复用现有会话
  const directButton = page.getByRole('button', { name: '与阿帆私聊' })
  if (await directButton.count() === 0) {
    await createRoleFromDossier(page, /开发工程师 v1/, '阿帆')
    await expect(page.getByRole('button', { name: '与阿帆私聊' })).toBeVisible()
  }
  await directButton.first().click()
  await expect(page.getByRole('heading', { name: '阿帆', exact: true })).toBeVisible()
  const traceWorld = server.store.listWorlds(server.store.listWorkspaces()[0]!.id)[0]!
  const traceEmployee = server.store.listEmployees(traceWorld.id).find((employee) => employee.displayName === '阿帆')!
  const agentTraceBefore = await (await fetch(`${origin}/api/worlds/${traceWorld.id}/trace?category=tool&actorId=${traceEmployee.id}&limit=200`)).json() as { items: Array<{ id: string; status: string; summary: string }> }
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await expect(composer).toBeEnabled()
  const ownerText = '任务：验证乐观发送与实时思考展示'
  await composer.fill(ownerText)
  await page.getByRole('button', { name: '发送' }).click()

  // 1) 发送后输入框立即清空（乐观更新，不等模型回合结束）
  await expect(composer).toHaveValue('')
  // 2) 用户消息立即上屏，不依赖 chat 响应返回
  await expect(page.locator('.message--owner').filter({ hasText: ownerText })).toBeVisible()

  // 3) 执行过程只进入右侧轨迹中心，聊天不再混入推理和工具事件
  await openDockTab(page.getByRole('region', { name: '世界与角色侧边栏' }), '轨迹')
  await expect(page.locator('.world-trace-panel')).toBeVisible()
  const executionTrace = page.locator('.world-trace-item').filter({ hasText: '完成处理' }).filter({ hasText: '阿帆' }).first()
  await expect(executionTrace).toBeVisible()
  await executionTrace.locator('summary').click()
  await expect(executionTrace.locator('.world-trace-item__detail')).toContainText('核对事实与权限')
  await expect(executionTrace.locator('.world-trace-item__detail')).toContainText('search_workspace')
  await expect(page.locator('.live-turns-block')).toHaveCount(0)
  await expect(page.locator('.reasoning-message')).toHaveCount(0)
  await expect(page.locator('.tool-event-message')).toHaveCount(0)

  // 视觉证据：思考过程进行中的三个视口截图（供视觉审批使用）
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-trace-1920x1080.png') })
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-trace-1440x900.png') })
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-trace-3840x2160.png') })
  await page.setViewportSize({ width: 1_584, height: 992 })

  // 4) 回合结束后同一稳定轨迹更新为完成，不追加重复生命周期卡片
  await expect.poll(async () => {
    const current = await (await fetch(`${origin}/api/worlds/${traceWorld.id}/trace?category=tool&actorId=${traceEmployee.id}&limit=200`)).json() as typeof agentTraceBefore
    return current.items.length
  }).toBe(agentTraceBefore.items.length + 1)
  const agentTraceAfter = await (await fetch(`${origin}/api/worlds/${traceWorld.id}/trace?category=tool&actorId=${traceEmployee.id}&limit=200`)).json() as typeof agentTraceBefore
  expect(agentTraceAfter.items).toHaveLength(agentTraceBefore.items.length + 1)
  await expect(page.locator('.world-trace-item').filter({ hasText: '完成处理' }).filter({ hasText: '阿帆' }).last()).toBeVisible()

  // 5) 模型执行失败不撤回已经持久化的用户消息；排队回合的失败原因进入轨迹
  const failedOwnerText = '模拟失败：这条用户消息必须保留在聊天中'
  const sendButton = page.locator('.composer .send-button')
  await expect(sendButton).toHaveAttribute('aria-label', '发送', { timeout: 15_000 })
  await composer.fill(failedOwnerText)
  const failedChatResponse = page.waitForResponse((response) => response.url().includes(`/api/worlds/${traceWorld.id}/chat`) && response.request().method() === 'POST')
  await sendButton.click()
  expect((await failedChatResponse).status()).toBe(202)
  await expect(page.locator('.message--owner').filter({ hasText: failedOwnerText })).toBeVisible()
  const failedTrace = page.locator('.world-trace-item').filter({ hasText: '处理失败' }).first()
  await expect(failedTrace).toBeVisible()
  await failedTrace.locator('summary').click()
  await expect(failedTrace.locator('.world-trace-item__detail')).toContainText('本轮运行未能完成，请在会话中重试。')

  // 视觉审批证据：记录控制台 error/warn，并断言无未捕获页面错误
  await writeFile(
    join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-trace-console.log'),
    `[pageerror]\n${pageErrors.join('\n')}\n\n[console]\n${consoleEntries.join('\n')}\n`,
    'utf8',
  )
  expect(pageErrors, `页面存在未捕获错误：${pageErrors.join('; ')}`).toEqual([])
})

test('shows real model interaction logs in the settings panel with filtering, detail, clear and visual evidence', async ({ page }) => {
  // 独立于前序测试：无工作区则自行 onboarding，已有则直接复用
  await page.goto(origin)
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
    await expect(shell).toBeVisible()
  }

  // 无“与阿帆私聊”则自行招募，已有则复用现有会话
  const directButton = page.getByRole('button', { name: '与阿帆私聊' })
  if (await directButton.count() === 0) {
    await createRoleFromDossier(page, /开发工程师 v1/, '阿帆')
    await expect(page.getByRole('button', { name: '与阿帆私聊' })).toBeVisible()
  }

  const workspaces = await (await fetch(`${origin}/api/workspaces`)).json() as { items: Array<{ id: string }> }
  const workspaceId = workspaces.items[0]!.id
  const beforeTotal = (await (await fetch(`${origin}/api/workspaces/${workspaceId}/model-interactions`)).json() as { total: number }).total

  // 发一条真实回合，触发 turn 级模型交互日志（用 @提及确保命中员工并创建会话）
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await expect(composer).toBeEnabled()
  await composer.fill('@阿帆 任务：请确认模型交互日志的采集')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('我先建立性能基线。').first()).toBeVisible()
  await expect.poll(async () =>
    (await (await fetch(`${origin}/api/workspaces/${workspaceId}/model-interactions`)).json() as { total: number }).total,
  ).toBeGreaterThan(beforeTotal)

  // 打开设置 → 使用记录
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: /使用记录/ }).click()
  await expect(settings.getByRole('heading', { name: '使用记录' })).toBeVisible()
  await expect(settings.locator('.log-entry').first()).toBeVisible()
  await expect(settings.locator('.log-entry__model').filter({ hasText: 'dsh-default' }).first()).toBeVisible()
  await expect(settings.locator('.log-status--success').first()).toBeVisible()
  await expect(settings.getByText('对话回合').first()).toBeVisible()

  // 展开详情：显示请求摘要（不含 prompt 明文）
  await settings.locator('.log-entry__row').first().click()
  await expect(settings.locator('.log-detail')).toBeVisible()
  await expect(settings.locator('.log-detail').getByText('请求摘要')).toBeVisible()
  await expect(settings.locator('.log-detail')).not.toContainText('请确认模型交互日志的采集')

  // 状态筛选
  await settings.locator('.log-filter select').first().selectOption('success')
  await expect(settings.locator('.log-entry').first()).toBeVisible()
  await expect(settings.locator('.log-status--success').first()).toBeVisible()

  // 视觉证据：日志面板三个视口截图 + 控制台 error/warn 记录（供视觉审批）
  const consoleEntries: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleEntries.push(`[${message.type()}] ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'model-logs-1920x1080.png') })
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'model-logs-1440x900.png') })
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'model-logs-3840x2160.png') })
  await page.setViewportSize({ width: 1_584, height: 992 })
  await writeFile(
    join(process.cwd(), 'artifacts', 'ui-world-conversations', 'model-logs-console.log'),
    `[pageerror]\n${pageErrors.join('\n')}\n\n[console]\n${consoleEntries.join('\n')}\n`,
    'utf8',
  )
  expect(pageErrors, `页面存在未捕获错误：${pageErrors.join('; ')}`).toEqual([])

  // 清空日志 → 空态提示
  page.once('dialog', (dialog) => void dialog.accept())
  await settings.getByRole('button', { name: '清空日志' }).click()
  await expect(settings.getByText('还没有使用记录')).toBeVisible()
  await expect.poll(async () =>
    (await (await fetch(`${origin}/api/workspaces/${workspaceId}/model-interactions`)).json() as { total: number }).total,
  ).toBe(0)
})

test('guides new users through world, role, permission, and review steps in Creative Workshop', async ({ page }) => {
  await page.goto(origin)
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
    await expect(shell).toBeVisible()
  }

  await page.getByRole('button', { name: '创意工坊', exact: true }).click()
  const workshop = page.getByRole('dialog', { name: '创意工坊' })
  await expect(workshop).toBeVisible()
  const createFirst = workshop.getByRole('button', { name: '创建第一个世界' })
  if (await createFirst.count()) await createFirst.click()
  else await workshop.getByRole('button', { name: '新建', exact: true }).click()

  await expect(workshop.getByRole('heading', { name: '先描述你要创建的世界' })).toBeVisible()
  await expect(workshop.getByLabel('角色名字')).toHaveCount(0)
  await workshop.getByLabel('世界名称').fill('向导验收世界')
  await workshop.getByLabel('当前目标').fill('验证引导式创建和最小权限配置。')
  await workshop.getByRole('button', { name: /下一步/ }).click()

  await expect(workshop.getByRole('heading', { name: '配置初始角色' })).toBeVisible()
  await expect(workshop.getByLabel('搜索角色 Skills')).toHaveCount(0)
  await workshop.getByLabel('角色名字').fill('向导管理员')
  await workshop.getByLabel('岗位 / 身份').fill('世界管理员')
  await workshop.getByLabel('职责摘要').fill('管理当前世界的角色设定和协作边界。')
  await workshop.getByLabel('工作原则与表达方式').fill('先核对当前世界身份和权限，再执行清晰、可审计的操作。')
  await workshop.getByRole('button', { name: /下一步/ }).click()

  await expect(workshop.getByRole('heading', { name: '为角色配置能力范围' })).toBeVisible()
  const skillSearch = workshop.getByLabel('搜索角色 Skills')
  await expect(skillSearch).toBeVisible()
  const firstSkill = workshop.locator('.creative-workshop-skill-catalog input[type="checkbox"]').first()
  await expect(firstSkill).toBeVisible()
  await firstSkill.check()
  await expect(workshop.getByText('已选择 1 个 Skill')).toBeVisible()
  await workshop.getByRole('button', { name: /下一步/ }).click()

  await expect(workshop.getByRole('heading', { name: '确认后创建本地世界' })).toBeVisible()
  await expect(workshop.getByText('向导验收世界', { exact: true })).toBeVisible()
  await expect(workshop.getByText('向导管理员', { exact: true })).toBeVisible()
  await expect(workshop.getByText('请求 1 个 Skill')).toBeVisible()
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'settings-experience', 'workshop-review-1920x1080.png') })
  await workshop.getByRole('button', { name: '关闭创意工坊' }).click()
})

test('locks the whole application immediately and again after a service restart', async ({ page }) => {
  test.setTimeout(90_000)
  const password = 'Local-only-lock-2026'
  await page.goto(origin)
  const shell = page.locator('.workbench-shell')
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  await expect(shell.or(onboarding)).toBeVisible()
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
    await expect(shell).toBeVisible()
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  let settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: /隐私与锁/ }).click()
  await settings.getByPlaceholder('至少 6 个字符').fill(password)
  await settings.getByPlaceholder('重复输入密码').fill(password)
  await settings.getByRole('button', { name: '启用应用锁' }).click()
  await expect(settings.getByText('应用锁已启用')).toBeVisible()
  await settings.getByRole('button', { name: '立即锁定' }).click()

  const lockScreen = page.locator('.application-lock-screen')
  await expect(lockScreen).toBeVisible()
  await expect(shell).toHaveCount(0)
  const lockPassword = lockScreen.getByLabel('应用访问密码')
  await lockPassword.fill('wrong-password')
  await lockScreen.getByRole('button', { name: '解锁应用' }).click()
  await expect(lockScreen.getByRole('alert')).toBeVisible()
  await lockPassword.fill(password)
  await lockScreen.getByRole('button', { name: '解锁应用' }).click()
  await expect(shell).toBeVisible()

  await page.goto('about:blank')
  await server.close()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new BrowserRuntime(),
  })
  origin = (await server.start()).origin
  await page.goto(origin)
  await expect(lockScreen).toBeVisible()
  await expect(shell).toHaveCount(0)
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'settings-experience', 'application-lock-1920x1080.png') })
  await lockScreen.getByLabel('应用访问密码').fill(password)
  await lockScreen.getByRole('button', { name: '解锁应用' }).click()
  await expect(shell).toBeVisible()

  await page.getByRole('button', { name: '设置', exact: true }).click()
  settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: /隐私与锁/ }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await settings.getByRole('button', { name: '关闭应用锁' }).click()
  await expect(settings.getByText('应用锁未启用')).toBeVisible()
})

async function createRoleFromDossier(page: import('@playwright/test').Page, blueprint: RegExp, displayName: string) {
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '角色')
  let add = dock.getByRole('button', { name: '新增角色', exact: true })
  if (await add.count() === 0) {
    const back = dock.getByRole('button', { name: '全员角色', exact: true })
    if (await back.count() > 0) await back.click()
    add = dock.getByRole('button', { name: '新增角色', exact: true })
  }
  await add.click()
  const dialog = page.getByRole('dialog', { name: '新增角色' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: blueprint }).click()
  await dialog.getByRole('textbox', { name: '角色名字（可选）' }).fill(displayName)
  await dialog.getByRole('button', { name: /确认新增|再创建一名/ }).click()
  await expect(dialog).toBeHidden()
}

class BrowserRuntime implements AgentRuntimePort {
  readonly eventIntervalMs: number

  constructor(options: { eventIntervalMs?: number } = {}) {
    this.eventIntervalMs = options.eventIntervalMs ?? 20
  }

  async runTurn(request: AgentTurnRequest) {
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    if (request.prompt.includes('模拟失败')) {
      request.onEvent?.({ kind: 'turn.started', source: 'browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 1, metadata: {} })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.eventIntervalMs))
      request.onEvent?.({ kind: 'turn.failed', source: 'browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 2, metadata: { failure: 'provider-authentication' } })
      return { agentSessionId, finalResponse: '', eventCount: 2 }
    }
    const events = [
      { kind: 'turn.started', sourceSequence: 1 },
      { kind: 'assistant.reasoning', sourceSequence: 2, content: '核对事实与权限。' },
      { kind: 'tool.started', sourceSequence: 3, toolName: 'search_workspace', callId: `call-${request.agent.id}` },
      { kind: 'tool.completed', sourceSequence: 4, callId: `call-${request.agent.id}`, failed: false },
      { kind: 'assistant.message', sourceSequence: 5, content: '我先建立性能基线。' },
      { kind: 'turn.completed', sourceSequence: 6 },
    ] as const
    for (const event of events) {
      request.onEvent?.({ ...event, source: 'browser-e2e', sourceSessionId: agentSessionId, metadata: {} })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.eventIntervalMs))
    }
    return { agentSessionId, finalResponse: '我先建立性能基线。', eventCount: events.length }
  }

  async close(): Promise<void> {}
}
