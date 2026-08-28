import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { CreativeWorkshopDraftV1 } from '../packages/contracts/lib/index.js'
import type { AgentRuntimePort } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
let worldModelProfileId = ''
let roleModelProfileId = ''
const quietRuntime: AgentRuntimePort = { async runTurn(request) { return { agentSessionId: request.agent.agentSessionId ?? `workshop-${request.agent.id}`, finalResponse: 'ok', eventCount: 0 } }, async close() {} }

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-workshop-v2-e2e-'))
  await startServer()
})

test.afterAll(async () => { await server?.close(); await rm(stateRoot, { recursive: true, force: true }) })

test('generates a five-character review draft and creates only after explicit confirmation', async ({ page }) => {
  await page.goto(origin)
  const initialWorldCount = server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id)).length
  await page.getByRole('button', { name: '创意工坊' }).click()
  await page.getByRole('button', { name: '新建空白世界' }).click()
  await page.getByPlaceholder(/创建一个围绕短剧制作/).fill('创建一个 AI 游戏开发工作室，有 5 个角色：一个产品经理、两个程序员、一个视觉设计师和一个运营。')
  await page.getByRole('button', { name: 'AI 生成草稿' }).click()
  await expect(page.getByText(/草稿已生成：1 个世界、5 个独立角色/)).toBeVisible()
  expect(server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id))).toHaveLength(initialWorldCount)

  await page.getByRole('button', { name: /下一步/ }).click()
  for (const name of ['林夕', '阿澈', '小北', '墨羽', '七七']) await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  await page.getByRole('button', { name: /下一步/ }).click()
  await expect(page.getByText('世界默认模型', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '选择世界默认模型' }).click()
  await page.getByRole('searchbox', { name: /搜索供应商/ }).fill('vision')
  await page.getByRole('option', { name: /Vision Model 4/ }).click()
  await page.getByRole('button', { name: '选择角色模型' }).click()
  await page.getByRole('searchbox', { name: /搜索供应商/ }).fill('tools')
  await page.getByRole('option', { name: /Tools Model 2/ }).click()
  await page.getByRole('button', { name: /下一步/ }).click()

  const screenshotRoot = join(process.cwd(), 'artifacts', 'creative-workshop-v2')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [{ width: 1366, height: 768, label: '1366x768' }, { width: 1440, height: 900, label: '1440x900' }, { width: 1920, height: 1080, label: '1920x1080' }, { width: 3840, height: 2160, label: '3840x2160' }]) {
    await page.setViewportSize(viewport)
    expect(await page.locator('.creative-workshop-dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `review-${viewport.label}.png`) })
  }
  await page.getByRole('button', { name: '查看和编辑 JSON' }).click()
  const jsonEditor = page.getByRole('dialog', { name: '查看和编辑 JSON 草稿' })
  const json = jsonEditor.getByLabel('创意工坊 JSON 草稿')
  await json.fill((await json.inputValue()).replace('七七', '柒柒'))
  await jsonEditor.getByRole('button', { name: '应用到草稿' }).click()
  await jsonEditor.getByRole('button', { name: '关闭 JSON 编辑器' }).click()
  await expect(page.getByText('柒柒', { exact: true })).toBeVisible()
  expect(server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id))).toHaveLength(initialWorldCount)

  await page.getByRole('button', { name: '创建世界', exact: true }).click()
  await expect(page.locator('.creative-workshop-dialog')).toBeHidden({ timeout: 20_000 })
  const createdWorld = server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id)).find((world) => world.name === '夜航工作室')
  expect(createdWorld).toBeDefined()
  const employees = server!.store.listEmployees(createdWorld!.id)
  expect(employees).toHaveLength(5)
  expect(employees.map((employee) => employee.displayName)).toContain('柒柒')
  expect(server!.store.getModelAssignment(createdWorld!.workspaceId, 'world', createdWorld!.id)?.modelProfileId).toBe(worldModelProfileId)
  expect(server!.store.getModelAssignment(createdWorld!.workspaceId, 'employee', employees.find((employee) => employee.displayName === '林夕')!.id)?.modelProfileId).toBe(roleModelProfileId)
  for (const employee of employees) expect(server!.store.getEmployeeRevision(employee.id, employee.currentRevision)?.skillGrants).toEqual([])
})

test('restores an autosaved draft after closing and reopening the workshop without creating a world', async ({ page }) => {
  await page.goto(origin)
  const before = server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id)).length
  await page.getByRole('button', { name: '创意工坊' }).click()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByLabel('世界名称').fill('重启恢复草稿')
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '关闭创意工坊' }).click()
  expect(server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id))).toHaveLength(before)

  await page.reload()
  await page.getByRole('button', { name: '创意工坊' }).click()
  await expect(page.getByText('已恢复上次未完成的本地草稿。')).toBeVisible()
  await expect(page.getByLabel('世界名称')).toHaveValue('重启恢复草稿')
  expect(server!.store.listWorkspaces().flatMap((workspace) => server!.store.listWorlds(workspace.id))).toHaveLength(before)
})

async function startServer() {
  server = await createCyberServer({
    stateRoot, workspacePath: stateRoot, webRoot: join(process.cwd(), 'packages', 'web', 'dist'), port: 0, bootstrapDefaultWorld: true, runtime: quietRuntime,
    workshopDraftGenerator: { async generate(_workspaceId, prompt): Promise<CreativeWorkshopDraftV1> {
      expect(typeof prompt).toBe('string')
      return {
        schemaVersion: 1,
        world: { name: '夜航工作室', description: '独立游戏开发工作室', purpose: '开发并发布游戏', modelPolicy: { mode: 'inherit' } },
        characters: [
          ['林夕', '产品经理'], ['阿澈', '程序员'], ['小北', '程序员'], ['墨羽', '视觉设计师'], ['七七', '运营'],
        ].map(([name, role], index) => ({ tempId: `draft-${index + 1}`, name: name!, role: role!, summary: `负责${role}`, requestedSkills: [], modelPolicy: { mode: 'inherit' } })),
      }
    } },
  })
  if (server.store.listModelProfiles(server.store.listWorkspaces()[0]!.id).length === 0) seedModels(server)
  origin = (await server.start()).origin
}

function seedModels(current: CyberServer) {
  const workspaceId = current.store.listWorkspaces()[0]!.id
  const capabilities = ['text', 'vision', 'reasoning', 'tools'] as const
  for (let provider = 1; provider <= 4; provider += 1) {
    for (let index = 1; index <= 6; index += 1) {
      const capability = capabilities[(provider + index) % capabilities.length]!
      const profile = current.store.saveModelProfile({
        workspaceId,
        displayName: `${capability[0]!.toUpperCase()}${capability.slice(1)} Model ${index}`,
        providerKind: 'openai-compatible-local',
        baseUrl: `http://127.0.0.1:${12000 + provider}/v1`,
        modelId: `${capability}-model-${index}`,
        api: 'openai-completions',
        isDefault: provider === 1 && index === 1,
        settings: { providerId: `provider-${provider}`, providerName: `Provider ${provider}`, capabilities: [capability], contextWindow: 32_000 * index },
      })
      if (profile.modelId === 'vision-model-4') worldModelProfileId = profile.id
      if (profile.modelId === 'tools-model-2') roleModelProfileId = profile.id
    }
  }
  if (!worldModelProfileId || !roleModelProfileId) throw new Error('Model picker fixtures were not created')
}
