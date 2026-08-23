import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer
let origin: string
let stateRoot: string

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-e2e-'))
  await mkdir(join(process.cwd(), 'artifacts', 'ui-world-conversations'), { recursive: true })
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

  const dock = page.getByRole('region', { name: '世界与角色档案侧边栏' })
  await dock.getByRole('button', { name: '档案', exact: true }).click()
  const engineerCard = dock.getByRole('article').filter({ hasText: '阿帆' })
  await expect(engineerCard).toBeVisible()
  await engineerCard.getByRole('button', { name: /完整档案/ }).click()
  await expect(dock.getByText('阿帆 / 独立角色档案')).toBeVisible()
  await dock.getByRole('button', { name: '全角色档案' }).click()
  await expect(dock.getByText('全角色数字档案', { exact: true })).toBeVisible()
  await expect(dock.getByRole('article').filter({ hasText: '阿帆' })).toBeVisible()

  await composer.fill('@阿帆 请确认真实回合')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('我先建立性能基线。').first()).toBeVisible()
  await page.getByText('阿帆的思考过程').first().click()
  await expect(page.getByText('核对事实与权限。').first()).toBeVisible()
  await expect(page.getByText('search_workspace').first()).toBeVisible()

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

test('runs direct and group conversations with real world lifecycle, persistence, and reconnect recovery', async ({ page }) => {
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()

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
  await expect(page.getByRole('heading', { name: '与 阿帆 对话', exact: true })).toBeVisible()
  await expect(page.getByLabel('当前会话成员')).toContainText('阿帆')
  const dock = page.getByRole('region', { name: '世界与角色档案侧边栏' })
  expect(server.store.getEmployee(engineer.id)?.status).toBe('available')
  expect(server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.started')).toHaveLength(taskStartedBeforeIntent)
  await dock.getByRole('button', { name: '档案', exact: true }).click()
  expect(server.store.getEmployee(engineer.id)?.status).toBe('available')
  expect(server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.started')).toHaveLength(taskStartedBeforeIntent)

  const taskCompletedBeforeSubmit = server.store.listWorldDomainEvents(worldId).filter((event) => event.type === 'task.completed').length
  await dock.getByRole('button', { name: '世界', exact: true }).click()
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
  await dock.getByRole('button', { name: '档案', exact: true }).click()
  await dock.getByRole('button', { name: '全角色档案', exact: true }).click()
  await expect(dock.getByText('全角色数字档案', { exact: true })).toBeVisible()
  await expect(dock.getByRole('button', { name: '文件', exact: true })).toHaveCount(0)
  await expect(dock.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)
})

test('keeps the workbench readable and the world viewport filled on a 4K display', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.goto(origin)
  const onboarding = page.getByRole('heading', { name: '创建第一个本地世界' })
  if (await onboarding.isVisible()) {
    await page.getByRole('button', { name: '创建我的世界' }).click()
  }
  const dock = page.getByRole('region', { name: '世界与角色档案侧边栏' })

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
  await dock.getByRole('button', { name: '档案', exact: true }).click()
  expect(Math.abs(((await page.locator('.right-pane').boundingBox())?.width ?? 0) - sharedWidth)).toBeLessThan(2)
  await expect(dock.getByRole('button', { name: '文件', exact: true })).toHaveCount(0)
  await expect(dock.getByRole('button', { name: '预览', exact: true })).toHaveCount(0)
  await dock.getByRole('button', { name: '世界', exact: true }).click()

  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-1920x1080.png') })

  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'world-1440x900.png') })
  for (let index = 0; index < 20; index += 1) {
    await dock.getByRole('button', { name: '档案', exact: true }).click()
    await expect(page.locator('.world-runtime-canvas')).toHaveCount(0)
    await dock.getByRole('button', { name: '世界', exact: true }).click()
    await expect(page.locator('.world-runtime-canvas')).toHaveCount(1)
  }
})

test('creates, edits, restores, and deletes a private-network sub2api model profile', async ({ page }) => {
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.goto(origin)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  let settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('button', { name: '模型', exact: true }).click()
  await expect(settings.getByRole('heading', { name: '模型与路由' })).toBeVisible()
  await expect(settings.getByText('模型配置与路由在当前页面单独保存')).toBeVisible()
  await expect(settings.getByText('温度', { exact: false })).toHaveCount(0)

  await settings.getByRole('button', { name: '添加配置' }).click()
  const editor = settings.getByRole('form', { name: '模型配置编辑器' })
  await editor.getByRole('combobox', { name: '提供商类型' }).selectOption('custom-local')
  await editor.getByRole('textbox', { name: '显示名称' }).fill('公司 sub2api')
  await editor.getByRole('textbox', { name: '接口地址' }).fill('http://172.16.1.125:11434/v1/')
  await editor.getByLabel('模型 ID').fill('qwen3.5:9b')
  await editor.getByRole('textbox', { name: /API 密钥/ }).fill('sk-e2e-test-only-not-real')
  await editor.getByRole('button', { name: '添加并保存' }).click()
  await expect(editor.getByRole('status')).toContainText('模型配置已添加并保存')
  await expect(settings.getByRole('article').filter({ hasText: '公司 sub2api' })).toContainText('qwen3.5:9b')

  await settings.getByRole('button', { name: '编辑公司 sub2api' }).click()
  await editor.getByLabel('模型 ID').fill('qwen3.5')
  await editor.getByRole('button', { name: '保存修改' }).click()
  await expect(editor.getByRole('status')).toContainText('模型配置已更新并保存')
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
  await settings.getByRole('button', { name: '模型', exact: true }).click()
  const restored = settings.getByRole('article').filter({ hasText: '公司 sub2api' })
  await expect(restored).toContainText('qwen3.5')
  await expect(restored).toContainText('API 密钥已保存')
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'model-settings-1920x1080.png') })

  page.once('dialog', (dialog) => dialog.accept())
  await settings.getByRole('button', { name: '删除公司 sub2api' }).click()
  await expect(settings.getByText('还没有模型配置')).toBeVisible()
  await expect(settings.getByText('模型配置已删除')).toBeVisible()
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
  const themeMarket = page.getByRole('dialog', { name: '市场' })
  await expect(themeMarket.getByRole('button', { name: '主题', exact: true })).toBeVisible()
  await themeMarket.getByRole('button', { name: '关闭市场' }).click()
  const dock = page.getByRole('region', { name: '世界与角色档案侧边栏' })
  await dock.getByRole('button', { name: '档案', exact: true }).click()

  await expect(dock.getByText('全员数字档案')).toBeVisible()
  await expect(dock.getByText('8 名角色')).toBeVisible()
  await expect(dock.getByRole('article')).toHaveCount(8)
  for (const employee of ['小羽', '老周', '阿帆', '小Q', '安澜', '墨游', '小E', '秘书']) {
    await expect(dock.getByRole('article').filter({ hasText: employee })).toBeVisible()
  }
  await expect(dock.getByText('8', { exact: true }).first()).toBeVisible()
  await expect(dock.getByText('32', { exact: true })).toBeVisible()
})

test('clears the composer instantly, shows the owner message on screen, and keeps the thinking trace visible during and after a turn', async ({ page }) => {
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
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await expect(composer).toBeEnabled()
  const ownerText = '任务：验证乐观发送与实时思考展示'
  await composer.fill(ownerText)
  await page.getByRole('button', { name: '发送' }).click()

  // 1) 发送后输入框立即清空（乐观更新，不等模型回合结束）
  await expect(composer).toHaveValue('')
  // 2) 用户消息立即上屏，不依赖 chat 响应返回
  await expect(page.locator('.message--owner').filter({ hasText: ownerText })).toBeVisible()

  // 3) 思考过程在回合进行中明显可见（turn.started → reasoning → tool 逐条到达）
  await expect(page.locator('.live-turns-block')).toBeVisible()
  await expect(page.locator('.live-turn--live')).toBeVisible()
  await expect(page.locator('.live-turn__badge')).toHaveText('实时')
  await expect(page.locator('.live-turn__reasoning').filter({ hasText: '核对事实与权限。' })).toBeVisible()
  await expect(page.locator('.tool-step').filter({ hasText: 'search_workspace' })).toBeVisible()

  // 视觉证据：思考过程进行中的三个视口截图（供视觉审批使用）
  await page.setViewportSize({ width: 1_920, height: 1_080 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'live-turns-1920x1080.png') })
  await page.setViewportSize({ width: 1_440, height: 900 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'live-turns-1440x900.png') })
  await page.setViewportSize({ width: 3_840, height: 2_160 })
  await page.screenshot({ path: join(process.cwd(), 'artifacts', 'ui-world-conversations', 'live-turns-3840x2160.png') })
  await page.setViewportSize({ width: 1_584, height: 992 })

  // 4) 回合结束后 liveTurns 保留一段时间，不立即清空
  await expect(page.locator('.live-turn--completed')).toBeVisible()
  await expect(page.locator('.live-turn--completed').filter({ hasText: '核对事实与权限。' })).toBeVisible()

  // 视觉审批证据：记录控制台 error/warn，并断言无未捕获页面错误
  await writeFile(
    join(process.cwd(), 'artifacts', 'ui-world-conversations', 'live-turns-console.log'),
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

  // 打开设置 → 日志记录
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '日志记录' }).click()
  await expect(settings.getByRole('heading', { name: '模型交互日志' })).toBeVisible()
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
  await expect(settings.getByText('还没有模型交互日志')).toBeVisible()
  await expect.poll(async () =>
    (await (await fetch(`${origin}/api/workspaces/${workspaceId}/model-interactions`)).json() as { total: number }).total,
  ).toBe(0)
})

async function createRoleFromDossier(page: import('@playwright/test').Page, blueprint: RegExp, displayName: string) {
  const dock = page.getByRole('region', { name: '世界与角色档案侧边栏' })
  await dock.getByRole('button', { name: '档案', exact: true }).click()
  let add = dock.getByRole('button', { name: '新增角色', exact: true })
  if (await add.count() === 0) {
    const back = dock.getByRole('button', { name: '全角色档案', exact: true })
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