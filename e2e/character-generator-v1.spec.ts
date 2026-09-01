import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import type { AgentRuntimePort, CharacterImportAnalyzeResult } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

let server: (CyberServer & { origin: string; root: string }) | undefined
let origin = ''
let stateRoot = ''
let e2eRuntime: CharacterGeneratorRuntime | undefined

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-character-generator-v1-e2e-'))
  const analyzer = {
    async analyze(): Promise<CharacterImportAnalyzeResult> {
      return {
        draft: {
          schemaVersion: 1,
          targetWorldTemplateId: 'personal-world',
          displayName: 'AI 工程师',
          role: '机器学习工程师与 AI 系统架构师',
          summary: '从数据到上线构建可靠的 AI 系统。',
          persona: '务实、数据驱动、追求可复现性；只依据当前世界中的可验证事实工作。',
          personalityTraits: ['务实', '数据驱动'],
          background: '经历过模型上线故障并坚持复盘。',
          requestedSkillIds: [],
          requestedCapabilities: [],
          sourceSummary: '来自 Markdown 角色资料。',
          sourceRefs: ['source:engineering-ai-engineer.md'],
        },
      }
    },
  }
  const runtime = new CharacterGeneratorRuntime()
  e2eRuntime = runtime
  const created = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
    characterImportAnalyzer: analyzer,
  } as any)
  const address = await created.start()
  server = Object.assign(created, { origin: address.origin, root: stateRoot })
  origin = address.origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('imports the real AI engineer Markdown, publishes only after review, installs, recruits and chats', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)

  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const sourcePath = join(process.cwd(), 'tests', 'fixtures', 'character-generator', 'engineering-ai-engineer.md')
  const source = await readFile(sourcePath, 'utf8')
  const initialEmployees = current.store.listEmployees(world.id).length
  const initialInstalled = current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)

  await page.goto(origin)
  // Chromium's ANGLE backend emits this performance diagnostic whenever a WebGL
  // canvas is read back on a headless GPU. It comes from the browser driver, not
  // from page code, so it must never fail the smoke run. Emitting it here keeps
  // the guarantee deterministic instead of depending on the CI GPU backend.
  await page.evaluate(() => {
    console.warn('GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels')
  })
  await page.getByRole('button', { name: '市场', exact: true }).click()
  const market = page.locator('.package-market-dialog')
  await expect(market).toHaveCount(1)
  await expect(market).toBeVisible()
  await market.getByRole('button', { name: '角色', exact: true }).click()
  await expect(market.getByRole('textbox', { name: '搜索', exact: true })).toBeVisible()
  const customRoleButton = market.getByRole('button', { name: '自定义角色', exact: true })
  await expect(customRoleButton).toBeVisible()
  await customRoleButton.click()

  const generator = market.locator('.character-generator')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(generator).toBeVisible()
  await expect(generator.getByText('创建方式', { exact: true })).toBeVisible()
  await generator.getByRole('radio', { name: '导入文件' }).click()
  const sourceFile = generator.locator('input[type="file"]').first()
  await expect(generator.locator('.character-generator-file-picker')).toBeVisible()
  await sourceFile.setInputFiles(sourcePath)
  await expect(generator.getByText(/已选择：engineering-ai-engineer\.md/)).toBeVisible()
  await expect(generator.locator('textarea').first()).toHaveValue(source)

  await generator.getByRole('button', { name: '开始分析', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '正在整理角色设定' })).toBeVisible()
  await expect(generator.getByText('分析完成。请继续检查并编辑草稿')).toBeVisible()
  await generator.getByRole('button', { name: '检查角色草稿', exact: true }).click()

  await expect(generator.getByLabel('角色名字')).toBeVisible()
  await expect(generator.getByLabel('岗位或身份')).toBeVisible()
  await expect(generator.getByLabel('Persona 与行为方式')).toBeVisible()
  await generator.getByLabel('角色名字').fill('AI 工程主管')
  await generator.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '确认发布角色模板' })).toBeVisible()
  await expect(generator.getByText('发布不会自动安装、招募角色或发送消息')).toBeVisible()

  await generator.getByRole('button', { name: '发布到角色市场', exact: true }).click()
  await expect(generator.getByText('角色模板已发布')).toBeVisible()
  expect(current.store.listEmployees(world.id)).toHaveLength(initialEmployees)
  expect(current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)).toEqual(initialInstalled)

  await generator.getByRole('button', { name: '查看并安装', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '扩展市场' })).toBeVisible()
  const roleCard = page.locator('.market-card-grid article').filter({ hasText: 'AI 工程主管' })
  await expect(roleCard).toBeVisible()
  await roleCard.getByRole('button', { name: '查看并安装', exact: true }).click()
  const permission = page.locator('.permission-review--market')
  await expect(permission).toBeVisible()
  await permission.getByRole('checkbox', { name: /我已审阅/ }).check()
  const installResponsePromise = page.waitForResponse((response) => response.url().includes('/marketplace/install'))
  await permission.getByRole('button', { name: /批准安装/ }).click()
  const installResponse = await installResponsePromise
  const installBody = await installResponse.text()
  expect(installResponse.ok(), installBody).toBe(true)
  await expect(roleCard.getByRole('button', { name: '招募到世界', exact: true }), consoleIssues.join('\n')).toBeVisible()

  await roleCard.getByRole('button', { name: '招募到世界', exact: true }).click()
  const recruitment = page.locator('.recruitment-dialog')
  await expect(recruitment).toBeVisible()
  await expect(recruitment.getByRole('button', { name: /AI 工程主管/ }).first()).toBeVisible()
  await recruitment.getByLabel('角色名字（可选）').fill('AI 工程主管实例')
  await recruitment.getByRole('button', { name: '确认新增', exact: true }).click()

  await expect(page.getByRole('button', { name: '与AI 工程主管实例私聊', exact: true })).toBeVisible()
  const composer = page.getByRole('textbox', { name: /给当前世界的/ })
  await composer.fill('请给出上线前检查建议。')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('AI 工程师测试回复：已完成上线前检查建议。')).toBeVisible()

  const createdEmployees = current.store.listEmployees(world.id).filter((employee) => employee.displayName === 'AI 工程主管实例')
  expect(createdEmployees).toHaveLength(1)
  const employee = createdEmployees[0]!
  expect(current.store.getEmployeeProfile(employee.id)).toBeDefined()
  expect(current.store.getEmployeeDossier(employee.id)?.revisions.length).toBeGreaterThan(0)
  expect(current.store.listSessions(world.id).some((session) => session.kind === 'direct' && current.store.listParticipants(session.id).some((participant) => participant.participantId === employee.id))).toBe(true)
  expect(e2eRuntime?.requests.some((request) => request.agent.id === employee.id)).toBe(true)
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

test('the shared console recorder ignores only the known GPU driver noise', async ({ page }) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  await page.goto('about:blank')

  await page.evaluate(() => {
    // Browser-driver noise: the one and only thing the recorder may drop.
    console.warn('GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels')
    // Everything below is application signal and must still fail the E2E.
    console.error('boom')
    console.error('Warning: Each child in a list should have a unique "key" prop.')
    console.warn('角色草稿自动保存失败')
    setTimeout(() => { throw new Error('unhandled render failure') })
  })

  // console and pageerror arrive on separate channels, so compare as a set.
  await expect.poll(() => issues.length).toBe(4)
  expect([...issues].sort()).toEqual([
    '[console:error] Warning: Each child in a list should have a unique "key" prop.',
    '[console:error] boom',
    '[console:warning] 角色草稿自动保存失败',
    '[pageerror] unhandled render failure',
  ].sort())
  expect(issues.some((issue) => issue.includes('GPU stall due to ReadPixels'))).toBe(false)
})


test('keeps the generator inside the dialog at every desktop width and confirms before discarding a draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(origin)
  await page.getByRole('button', { name: '市场', exact: true }).click()
  const market = page.locator('.package-market-dialog')
  await market.getByRole('button', { name: '角色', exact: true }).click()
  const customRoleButton = market.getByRole('button', { name: '自定义角色', exact: true })
  await customRoleButton.click()

  const generator = market.locator('.character-generator')
  await expect(generator).toBeVisible()
  await generator.locator('.character-generator-field--source textarea').fill('一名沉着的技术负责人。')
  await generator.getByRole('button', { name: '开始分析', exact: true }).click()
  await expect(generator.getByText('分析完成。请继续检查并编辑草稿')).toBeVisible()
  await generator.getByRole('button', { name: '检查角色草稿', exact: true }).click()
  await expect(generator.getByLabel('角色名字')).toBeVisible()

  // The back link and the step actions must stay inside the dialog, and the
  // page must never scroll sideways, whatever the desktop width.
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    const backLink = generator.locator('.character-generator__back-link')
    await expect(backLink).toBeVisible()
    const dialogBox = (await market.boundingBox())!
    const backBox = (await backLink.boundingBox())!
    expect(backBox.height, `back link collapsed at ${size.width}`).toBeGreaterThan(20)
    expect(backBox.y + backBox.height, `back link clipped at ${size.width}`).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1)
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(horizontalOverflow, `horizontal overflow at ${size.width}`).toBeLessThanOrEqual(1)
    // The primary action is reachable by scrolling the step body.
    await generator.locator('.character-generator__body').evaluate((node) => { node.scrollTop = node.scrollHeight })
    await expect(generator.getByRole('button', { name: '下一步', exact: true })).toBeInViewport()
  }

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.keyboard.press('Escape')
  const confirmation = generator.getByRole('alertdialog')
  await expect(confirmation).toBeVisible()
  await expect(confirmation).toContainText('放弃未保存的角色草稿？')
  await expect(confirmation.getByRole('button', { name: '继续编辑', exact: true })).toBeFocused()
  await expect(generator).toBeVisible()

  // Escape inside the confirmation means keep editing, not discard.
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeHidden()
  await expect(generator).toBeVisible()

  await confirmationDiscard(page, generator)
  await expect(generator).toBeHidden()
  await expect(customRoleButton).toBeFocused()
})

async function confirmationDiscard(page: import('@playwright/test').Page, generator: import('@playwright/test').Locator) {
  await page.keyboard.press('Escape')
  await generator.getByRole('alertdialog').getByRole('button', { name: '放弃草稿', exact: true }).click()
}

class CharacterGeneratorRuntime implements AgentRuntimePort {
  readonly requests: Array<{ agent: { id: string }; prompt: string }> = []

  async runTurn(request: any) {
    this.requests.push({ agent: { id: request.agent.id }, prompt: request.prompt })
    return {
      agentSessionId: `character-generator-e2e-${request.agent.id}`,
      finalResponse: 'AI 工程师测试回复：已完成上线前检查建议。',
      eventCount: 0,
    }
  }

  async close() {}
}

function requireServer(): CyberServer & { origin: string; root: string } {
  if (server === undefined) throw new Error('Character Generator E2E server is not started')
  return server
}

// A 1x1 opaque PNG. Small enough to inline, real enough to pass the signature
// checks on the publish and avatar-asset boundaries.
const UPLOADED_AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('recruits a character that renders the uploaded avatar, not a built-in one', async ({ page }) => {
  await page.goto(origin)
  await generateTalent(page, {
    displayName: '头像上传角色',
    employeeName: '头像上传角色实例',
    upload: UPLOADED_AVATAR_PNG,
  })

  // Assert the avatar the browser actually paints for the recruited
  // character, on a real character surface -- not the marketplace card.
  const conversationRow = page.getByRole('button', { name: '与头像上传角色实例私聊', exact: true })
  await expect(conversationRow).toBeVisible()
  const listAvatar = conversationRow.locator('.avatar--custom img')
  await expect(listAvatar).toHaveCount(1)
  const source = await listAvatar.getAttribute('src')
  expect(source, 'recruited character fell back to a built-in avatar').toMatch(/^\/api\/assets\//)

  // The rendered source must resolve to the uploaded bytes.
  const served = await page.request.get(`${origin}${source!}`)
  expect(served.status()).toBe(200)
  expect(Buffer.from(await served.body()).equals(UPLOADED_AVATAR_PNG)).toBe(true)

  // The same image is still there after a reload.
  await page.reload()
  const reloaded = page.getByRole('button', { name: '与头像上传角色实例私聊', exact: true })
  await expect(reloaded).toBeVisible()
  await expect(reloaded.locator('.avatar--custom img')).toHaveAttribute('src', source!)
})

test('keeps one stable built-in avatar when no image is uploaded', async ({ page }) => {
  const current = requireServer()
  const world = current.store.listWorlds(current.store.listWorkspaces()[0]!.id)[0]!

  await page.goto(origin)
  await generateTalent(page, { displayName: '默认头像角色', employeeName: '默认头像角色实例' })

  const conversationRow = page.getByRole('button', { name: '与默认头像角色实例私聊', exact: true })
  await expect(conversationRow).toBeVisible()
  // No upload means the built-in sprite, whose slot is encoded in the
  // rendered background offsets.
  await expect(conversationRow.locator('.avatar--custom img')).toHaveCount(0)
  const slot = await conversationRow.locator('.avatar').first().getAttribute('style')
  expect(slot, 'built-in avatar renders no sprite slot').toBeTruthy()

  // The choice has to belong to the character. While it is only derived at
  // render time it silently depends on where the character happens to sit in
  // the world roster, which is what makes it drift.
  const employee = current.store.listEmployees(world.id).find((item) => item.displayName === '默认头像角色实例')!
  const appearance = current.store.getEmployeeProfile(employee.id)?.appearance ?? {}
  expect(appearance.avatarIndex, `character stores no avatar slot: ${JSON.stringify(appearance)}`)
    .toEqual(expect.any(Number))
  expect(slot).toBe(spriteSlotStyle(appearance.avatarIndex as number))

  // Archiving an earlier colleague moves this character up the roster. A
  // position-derived avatar re-rolls here; a stored one does not.
  const earlier = current.store.listEmployees(world.id).find((item) => item.id !== employee.id)!
  current.store.archiveEmployee(earlier.id)

  await page.reload()
  const reloaded = page.getByRole('button', { name: '与默认头像角色实例私聊', exact: true })
  await expect(reloaded).toBeVisible()
  await expect(reloaded.locator('.avatar').first()).toHaveAttribute('style', slot!)
})

/** Mirrors how Avatar turns a built-in slot into sprite-sheet offsets. */
function spriteSlotStyle(index: number): string {
  return `--avatar-x: ${(index % 4) * 33.3333}%; --avatar-y: ${Math.floor(index / 4) * 100}%;`
}

/** Runs the whole generator flow: analyze, review, publish, install, recruit. */
async function generateTalent(
  page: Page,
  input: { displayName: string; employeeName: string; upload?: Buffer },
): Promise<void> {
  await page.getByRole('button', { name: '市场', exact: true }).click()
  const market = page.locator('.package-market-dialog')
  await expect(market).toBeVisible()
  await market.getByRole('button', { name: '角色', exact: true }).click()
  await market.getByRole('button', { name: '自定义角色', exact: true }).click()

  const generator = market.locator('.character-generator')
  await expect(generator).toBeVisible()
  await generator.locator('textarea').first().fill(`${input.displayName} 负责端到端交付，擅长把复杂问题拆成可执行步骤。`)
  await generator.getByRole('button', { name: '开始分析', exact: true }).click()
  await expect(generator.getByText('分析完成。请继续检查并编辑草稿')).toBeVisible()
  await generator.getByRole('button', { name: '检查角色草稿', exact: true }).click()

  await expect(generator.getByLabel('角色名字')).toBeVisible()
  await generator.getByLabel('角色名字').fill(input.displayName)
  if (input.upload !== undefined) {
    await generator.locator('.character-generator-avatar input[type="file"]').setInputFiles({
      name: 'portrait.png',
      mimeType: 'image/png',
      buffer: input.upload,
    })
    await expect(generator.getByText(/已选择图片：portrait\.png/).first()).toBeVisible()
  }
  await generator.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(generator.getByRole('heading', { name: '确认发布角色模板' })).toBeVisible()
  await generator.getByRole('button', { name: '发布到角色市场', exact: true }).click()
  await expect(generator.getByText('角色模板已发布')).toBeVisible()
  await generator.getByRole('button', { name: '查看并安装', exact: true }).click()

  const card = page.locator('.market-card-grid article').filter({ hasText: input.displayName })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '查看并安装', exact: true }).click()
  const permission = page.locator('.permission-review--market')
  await expect(permission).toBeVisible()
  await permission.getByRole('checkbox', { name: /我已审阅/ }).check()
  const installed = page.waitForResponse((response) => response.url().includes('/marketplace/install'))
  await permission.getByRole('button', { name: /批准安装/ }).click()
  expect((await installed).ok()).toBe(true)

  await card.getByRole('button', { name: '招募到世界', exact: true }).click()
  const recruitment = page.locator('.recruitment-dialog')
  await expect(recruitment).toBeVisible()
  await recruitment.getByLabel('角色名字（可选）').fill(input.employeeName)
  await recruitment.getByRole('button', { name: '确认新增', exact: true }).click()
}
