import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, CharacterImportAnalyzeResult } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

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
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleIssues.push(`[console:${message.type()}] ${message.text()}`)
  })
  page.on('pageerror', (error) => consoleIssues.push(`[pageerror] ${error.message}`))

  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const sourcePath = join(process.cwd(), 'tests', 'fixtures', 'character-generator', 'engineering-ai-engineer.md')
  const source = await readFile(sourcePath, 'utf8')
  const initialEmployees = current.store.listEmployees(world.id).length
  const initialInstalled = current.store.listInstalledPackages(workspace.id).map((item) => `${item.packageId}@${item.version}`)

  await page.goto(origin)
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
