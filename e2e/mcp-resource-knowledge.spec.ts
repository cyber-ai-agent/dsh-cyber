import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import type { McpClientFactory } from '../packages/server/lib/integrations/mcp-client.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'

let stateRoot = ''
let server: CyberServer
let origin = ''
let resourceText = '当前世界可以引用这份真实的 MCP 资源。'
const uri = 'notes://reference?access_token=never-persist-this'

const mcpClients: McpClientFactory = {
  async connect() {
    return {
      async listTools() { return [] },
      async callTool() { return undefined },
      async listResources() { return [{ uri, name: 'reference', title: 'MCP 产品资料', mimeType: 'text/plain' }] },
      async readResource(requestedUri) { return [{ uri: requestedUri, mimeType: 'text/plain', text: resourceText }] },
      async close() {},
    }
  },
}

const runtime: AgentRuntimePort = {
  async runTurn(request: AgentTurnRequest) { return { agentSessionId: `mcp-resource-${request.agent.id}`, finalResponse: '已收到。', eventCount: 0 } },
  async close() {},
}

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-mcp-resource-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
    mcpClientFactory: mcpClients,
  })
  origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const saved = await fetch(`${origin}/api/workspaces/${workspace.id}/integrations/builtin.mcp`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { service: 'notes', mode: 'remote', endpoint: 'https://mcp.example.test/mcp', displayName: '资料服务' }, enabled: true }),
  })
  expect(saved.status, await saved.text()).toBe(200)
})

test.afterAll(async () => { await server?.close(); if (stateRoot) await rm(stateRoot, { recursive: true, force: true }) })

test('previews an MCP resource, rejects a changed version, and imports only the reviewed text into this world', async ({ page }, info) => {
  const issues: string[] = []
  attachAppConsoleRecorder(page, issues)
  const world = server.store.listWorlds(server.store.listWorkspaces()[0]!.id)[0]!
  await page.goto(origin)
  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '知识')
  const knowledge = page.getByRole('region', { name: `${world.name} - 知识`, exact: true })
  await knowledge.getByRole('button', { name: '导入资料' }).click()
  await knowledge.getByRole('menuitem', { name: '从 MCP 资源导入' }).click()
  const panel = knowledge.getByRole('region', { name: '从 MCP 资源导入' })
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('MCP 连接')).not.toHaveValue('')
  await panel.getByRole('button', { name: '读取资源目录' }).click()
  await panel.getByRole('button', { name: /MCP 产品资料/ }).click()
  await expect(panel.locator('pre')).toContainText('当前世界可以引用')

  resourceText = '预览后被修改的资源版本。'
  await panel.getByRole('button', { name: '导入当前世界' }).click()
  await expect(panel.getByRole('alert')).toContainText('预览后发生变化')
  expect(server.knowledge.listDocuments(world.id)).toHaveLength(0)
  expect(issues.some((issue) => issue.includes('409 (Conflict)'))).toBe(true)
  issues.length = 0

  resourceText = '当前世界可以引用这份真实的 MCP 资源。'
  await panel.getByRole('button', { name: /MCP 产品资料/ }).click()
  await expect(panel.locator('pre')).toContainText('当前世界可以引用')
  for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
    await page.setViewportSize(size)
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: info.outputPath(`mcp-resource-${size.width}x${size.height}.png`) })
  }
  await panel.getByRole('button', { name: '导入当前世界' }).click()
  await expect(panel.getByRole('status')).toContainText('已保存到当前世界知识库')
  const document = server.knowledge.listDocuments(world.id)[0]!
  expect(document.relativePath).toMatch(/^mcp\/notes\/[0-9a-f]{32}\.md$/)
  expect(document.status).toBe('indexed')
  const preview = server.knowledge.previewDocument(world.id, document.id)
  expect(JSON.stringify(preview)).toContain('当前世界可以引用')
  expect(JSON.stringify(preview)).not.toContain('never-persist-this')

  resourceText = '更新后的 MCP 内容仍属于同一份本地资料。'
  await panel.getByRole('button', { name: /MCP 产品资料/ }).click()
  await expect(panel.locator('pre')).toContainText('更新后的 MCP 内容')
  await panel.getByRole('button', { name: '导入当前世界' }).click()
  await expect(panel.getByRole('status')).toContainText('已保存到当前世界知识库')
  await expect.poll(() => JSON.stringify(server.knowledge.previewDocument(world.id, document.id))).toContain('更新后的 MCP 内容')
  expect(server.knowledge.listDocuments(world.id)).toHaveLength(1)
  expect(server.knowledge.listDocuments(world.id)[0]?.id).toBe(document.id)
  expect(JSON.stringify(server.knowledge.previewDocument(world.id, document.id))).toContain('更新后的 MCP 内容')
  expect(issues, issues.join('\n')).toEqual([])
})
