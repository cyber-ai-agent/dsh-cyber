import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { openDockTab } from './dock-test-helpers.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'

const MARKDOWN_TITLE = '运行交付说明'
const HTML_TITLE = '运行预览页面'
const MARKDOWN_PATH = 'run-output/brief.md'
const HTML_PATH = 'run-output/index.html'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''
let runtime: ArtifactBrowserRuntime

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-artifact-center-e2e-'))
  await startServer()
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('publishes one BrowserRuntime run into the world artifact center and keeps it isolated', async ({ page }) => {
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  const screenshotRoot = join(process.cwd(), 'artifacts', 'world-artifact-center')
  await mkdir(screenshotRoot, { recursive: true })

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()

  const currentServer = requireServer()
  const workspace = currentServer.store.listWorkspaces()[0]!
  const world = currentServer.store.listWorlds(workspace.id)[0]!
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.fill('请生成本次运行的 Markdown 交付说明和 HTML 预览页面。')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('已生成 Markdown 与 HTML 交付文件。').first()).toBeVisible()
  await expect(page.getByRole('region', { name: '消息中的产物' })).toBeVisible()
  await expect(page.getByRole('region', { name: '消息中的产物' })).toContainText(MARKDOWN_TITLE)
  await expect(page.getByRole('region', { name: '消息中的产物' })).toContainText(HTML_TITLE)

  const run = runtime.lastRequest
  expect(run).toBeDefined()
  expect(run?.agentRunId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  expect(run?.workspacePath.toLowerCase()).toContain(join(stateRoot, 'worlds', encodeURIComponent(world.id), 'files').toLowerCase())
  const agentRunId = run!.agentRunId!
  const manifestPath = join(run!.workspacePath, '.dsh', 'artifacts', `${agentRunId}.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  expect(manifest).toEqual({
    schemaVersion: 1,
    artifacts: [
      { path: MARKDOWN_PATH, title: MARKDOWN_TITLE, kind: 'markdown', description: '本次运行生成的 Markdown 交付说明。' },
      { path: HTML_PATH, title: HTML_TITLE, kind: 'html', description: '本次运行生成的隔离 HTML 预览。' },
    ],
  })

  const filesRoot = join(stateRoot, 'worlds', encodeURIComponent(world.id), 'files')
  await expect(readFile(join(filesRoot, MARKDOWN_PATH), 'utf8')).resolves.toContain('# 运行交付说明')
  await expect(readFile(join(filesRoot, HTML_PATH), 'utf8')).resolves.toContain('<h1>运行预览页面</h1>')

  const published = currentServer.artifacts.list(world.id)
  expect(published.map((artifact) => artifact.title).sort()).toEqual([HTML_TITLE, MARKDOWN_TITLE].sort())
  const htmlArtifact = published.find((artifact) => artifact.title === HTML_TITLE)!
  const htmlPreviewResponse = await fetch(`${origin}/api/worlds/${world.id}/artifacts/${htmlArtifact.id}/preview/1`)
  expect(htmlPreviewResponse.status).toBe(200)
  const htmlPreviewPolicy = htmlPreviewResponse.headers.get('content-security-policy') ?? ''
  expect(htmlPreviewPolicy).toContain("connect-src 'none'")
  expect(htmlPreviewPolicy).toContain('sandbox allow-scripts')
  expect(currentServer.store.database.prepare('SELECT COUNT(*) AS count FROM world_artifacts WHERE world_id = ?').get(world.id)).toEqual({ count: 2 })
  expect(currentServer.store.database.prepare('SELECT COUNT(*) AS count FROM world_artifact_versions WHERE artifact_id IN (SELECT id FROM world_artifacts WHERE world_id = ?)').get(world.id)).toEqual({ count: 2 })
  for (const artifact of published) {
    const detail = currentServer.artifacts.get(world.id, artifact.id)
    expect(detail.versions).toHaveLength(1)
    const version = detail.versions[0]!
    const publishedPath = join(stateRoot, 'worlds', encodeURIComponent(world.id), ...version.relativePath.split('/'))
    await expect(readFile(publishedPath, 'utf8')).resolves.toBe(
      artifact.title === MARKDOWN_TITLE
        ? '# 运行交付说明\n\n- 一次真实角色运行回合\n- 版本与来源可追溯\n\n| 字段 | 值 |\n| --- | --- |\n| 状态 | 已发布 |\n\n> 这是表格、引用与代码块的阅读验证内容。\n\n```ts\nconst artifact = "durable"\n```\n\n[打开运行记录](/trace)\n'
        : '<!doctype html><html><head><meta charset="utf-8"><title>运行预览页面</title></head><body><h1>运行预览页面</h1><p>此页面来自当前世界的角色运行。</p></body></html>\n',
    )
  }

  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '产物')
  const center = page.getByRole('region', { name: '世界产物中心' })
  await expect(center).toBeVisible()
  await expect(center.getByRole('list', { name: '产物列表' })).toContainText(MARKDOWN_TITLE)
  await expect(center.getByRole('list', { name: '产物列表' })).toContainText(HTML_TITLE)

  await center.getByRole('button', { name: `打开产物 ${MARKDOWN_TITLE}` }).click()
  const markdownDetail = page.getByRole('region', { name: `${MARKDOWN_TITLE}产物详情` })
  await expect(markdownDetail).toBeVisible()
  const markdownReader = markdownDetail.locator('.artifact-markdown-reader')
  await expect(markdownReader.locator('h1')).toContainText(MARKDOWN_TITLE)
  await expect(markdownReader.locator('ul')).toContainText('一次真实角色运行回合')
  await expect(markdownReader.locator('table')).toContainText('已发布')
  await expect(markdownReader.locator('blockquote')).toContainText('阅读验证内容')
  await expect(markdownReader.locator('pre code')).toContainText('durable')
  await expect(markdownReader.getByRole('button', { name: '查看原文' })).toBeVisible()
  await expect(markdownReader.getByRole('button', { name: '复制' })).toBeVisible()
  await expect(markdownDetail.locator('header').getByRole('link', { name: '打开文件' })).toHaveAttribute('href', /\/artifacts\/[^/]+\/preview/)
  await markdownReader.getByRole('button', { name: '查看原文' }).click()
  await expect(markdownDetail.locator('.artifact-source-view')).toContainText('# 运行交付说明')
  await markdownDetail.locator('.artifact-reader').getByRole('button', { name: '查看原文' }).click()
  await expect(markdownDetail.locator('.artifact-markdown-reader')).toBeVisible()

  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(markdownDetail).toBeVisible()
    await page.screenshot({ path: join(screenshotRoot, `artifact-markdown-${viewport.label}.png`), fullPage: false })
  }

  await markdownDetail.getByRole('button', { name: '返回产物' }).click()
  await expect(center).toBeVisible()
  await center.getByRole('button', { name: `打开产物 ${HTML_TITLE}` }).click()
  const htmlDetail = page.getByRole('region', { name: `${HTML_TITLE}产物详情` })
  await expect(htmlDetail).toBeVisible()
  const htmlFrame = htmlDetail.locator('iframe.artifact-html-preview')
  await expect(htmlFrame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(htmlFrame).not.toHaveAttribute('sandbox', /allow-same-origin/)
  await expect(htmlFrame).toHaveAttribute('src', new RegExp(`/api/worlds/${encodeURIComponent(world.id)}/artifacts/[^/]+/preview`))
  await expect(htmlFrame).not.toHaveAttribute('src', /blob:/)

  await page.reload()
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const afterReloadDock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(afterReloadDock, '产物')
  await expect(page.getByRole('region', { name: '世界产物中心' })).toContainText(MARKDOWN_TITLE)
  await expect(page.getByRole('region', { name: '世界产物中心' })).toContainText(HTML_TITLE)

  await page.close()
  await currentServer.close()
  await startServer()
  const restartedPage = await page.context().newPage()
  attachAppConsoleRecorder(restartedPage, consoleIssues)
  await restartedPage.goto(origin)
  await expect(restartedPage.locator('.workbench-shell')).toBeVisible()
  const afterRestartList = await readJson<{ artifacts: Array<{ id: string; title: string }> }>(`${origin}/api/worlds/${world.id}/artifacts`)
  expect(afterRestartList.artifacts.map((artifact) => artifact.title).sort()).toEqual([HTML_TITLE, MARKDOWN_TITLE].sort())
  expect(requireServer().store.database.prepare('SELECT COUNT(*) AS count FROM world_artifacts WHERE world_id = ?').get(world.id)).toEqual({ count: 2 })

  const workspaceAfterRestart = requireServer().store.listWorkspaces().find((item) => item.id === workspace.id)!
  const secondWorldResponse = await fetch(`${origin}/api/workspaces/${workspaceAfterRestart.id}/worlds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '产物隔离世界', templateId: 'personal-world' }),
  })
  expect(secondWorldResponse.status).toBe(201)
  const { world: secondWorld } = await secondWorldResponse.json() as { world: { id: string; name: string } }
  const recruitResponse = await fetch(`${origin}/api/worlds/${secondWorld.id}/recruit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blueprintId: 'core.butler', blueprintVersion: 1, displayName: '隔离管家' }),
  })
  expect(recruitResponse.status).toBe(201)
  expect((await readJson<{ artifacts: unknown[] }>(`${origin}/api/worlds/${secondWorld.id}/artifacts`)).artifacts).toHaveLength(0)

  await restartedPage.reload()
  const worldSwitcher = restartedPage.getByLabel(`切换世界，当前为${world.name}`)
  await expect(worldSwitcher).toBeVisible()
  await worldSwitcher.click()
  await restartedPage.getByRole('menuitemradio', { name: new RegExp(secondWorld.name) }).click()
  await expect(restartedPage.getByLabel(`切换世界，当前为${secondWorld.name}`)).toBeVisible()
  const secondDock = restartedPage.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(secondDock, '产物')
  const secondCenter = restartedPage.getByRole('region', { name: '世界产物中心' })
  await expect(secondCenter.getByText('这个世界还没有已发布产物')).toBeVisible()
  await expect(secondCenter.getByRole('button', { name: `打开产物 ${MARKDOWN_TITLE}` })).toHaveCount(0)

  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function startServer(): Promise<void> {
  runtime = new ArtifactBrowserRuntime()
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime,
  })
  origin = (await server.start()).origin
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('Artifact E2E server is not running')
  return server
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`)
  return await response.json() as T
}

class ArtifactBrowserRuntime implements AgentRuntimePort {
  lastRequest: AgentTurnRequest | undefined

  async runTurn(request: AgentTurnRequest) {
    this.lastRequest = request
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    const markdown = '# 运行交付说明\n\n- 一次真实角色运行回合\n- 版本与来源可追溯\n\n| 字段 | 值 |\n| --- | --- |\n| 状态 | 已发布 |\n\n> 这是表格、引用与代码块的阅读验证内容。\n\n```ts\nconst artifact = "durable"\n```\n\n[打开运行记录](/trace)\n'
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>运行预览页面</title></head><body><h1>运行预览页面</h1><p>此页面来自当前世界的角色运行。</p></body></html>\n'
    await mkdir(join(request.workspacePath, 'run-output'), { recursive: true })
    await writeFile(join(request.workspacePath, MARKDOWN_PATH), markdown, 'utf8')
    await writeFile(join(request.workspacePath, HTML_PATH), html, 'utf8')
    await mkdir(join(request.workspacePath, '.dsh', 'artifacts'), { recursive: true })
    await writeFile(join(request.workspacePath, '.dsh', 'artifacts', `${request.agentRunId!}.json`), JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        { path: MARKDOWN_PATH, title: MARKDOWN_TITLE, kind: 'markdown', description: '本次运行生成的 Markdown 交付说明。' },
        { path: HTML_PATH, title: HTML_TITLE, kind: 'html', description: '本次运行生成的隔离 HTML 预览。' },
      ],
    }, null, 2) + '\n', 'utf8')

    request.onEvent?.({ kind: 'turn.started', source: 'artifact-browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 1, metadata: {} })
    request.onEvent?.({ kind: 'tool.started', source: 'artifact-browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 2, toolName: 'write_workspace', callId: `call-${request.agent.id}`, metadata: {} })
    request.onEvent?.({ kind: 'tool.completed', source: 'artifact-browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 3, callId: `call-${request.agent.id}`, failed: false, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'artifact-browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 4, content: '已生成 Markdown 与 HTML 交付文件。', metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'artifact-browser-e2e', sourceSessionId: agentSessionId, sourceSequence: 5, metadata: {} })
    return { agentSessionId, finalResponse: '已生成 Markdown 与 HTML 交付文件。', eventCount: 5 }
  }

  async close(): Promise<void> {}
}
