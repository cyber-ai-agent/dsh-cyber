import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import type {
  KnowledgeExtractionPort,
  KnowledgeExtractionRequest,
} from '../packages/server/lib/services/knowledge-extraction.js'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-knowledge-graph-e2e-'))
  await startServer(true)
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('consolidates visible evidence, renders the Canvas graph, and survives restart', async ({ page }) => {
  const current = requireServer()
  const workspace = current.store.listWorkspaces()[0]!
  const world = current.store.listWorlds(workspace.id)[0]!
  const session = current.store.listSessions(world.id)[0] ?? current.store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: '知识图谱证据',
  })
  const message = current.store.appendMessage({
    sessionId: session.id,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content: '北极星计划采用 SQLite 作为本地权威数据源。',
  })
  current.store.appendMessage({
    sessionId: session.id,
    senderId: 'system',
    senderKind: 'system',
    kind: 'reasoning',
    content: '这段隐藏推理绝不能成为知识证据。',
  })

  const response = await fetch(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceType: 'conversation', sourceId: session.id, fromCursor: Math.max(0, message.sequence - 1), toCursor: message.sequence }),
  })
  expect(response.status, await response.text()).toBe(202)

  const unsupportedManualSource = await fetch(`${origin}/api/worlds/${world.id}/knowledge/consolidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceType: 'manual', sourceId: 'unverified-note' }),
  })
  expect(unsupportedManualSource.status).toBe(422)

  const graph = await expectGraph(world.id)
  expect(graph.entities).toEqual(expect.arrayContaining([expect.objectContaining({ canonicalName: '北极星计划' }), expect.objectContaining({ canonicalName: 'SQLite' })]))
  expect(graph.evidence).toEqual([expect.objectContaining({ messageId: message.id, sourceType: 'conversation' })])
  expect(JSON.stringify(graph)).not.toContain('隐藏推理')
  expect(current.store.listWorldSkillActions(world.id)).toHaveLength(0)

  const consoleIssues: string[] = []
  attachConsoleRecorder(page, consoleIssues)
  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  await page.getByRole('region', { name: '世界与角色侧边栏' }).getByRole('button', { name: '知识', exact: true }).click()
  await page.getByRole('tab', { name: /知识图谱/ }).click()
  await expect(page.getByRole('heading', { name: '知识图谱' })).toBeVisible()
  const canvas = page.locator('canvas[aria-label*="知识图谱画布"]')
  await expect(canvas).toBeVisible()
  await expect.poll(async () => canvas.evaluate((element) => {
    const graphCanvas = element as HTMLCanvasElement
    const context = graphCanvas.getContext('2d')
    if (context === null || graphCanvas.width === 0 || graphCanvas.height === 0) return 0
    const pixels = context.getImageData(0, 0, graphCanvas.width, graphCanvas.height).data
    let coloredPixels = 0
    for (let index = 0; index < pixels.length; index += 16) {
      const red = pixels[index] ?? 0
      const green = pixels[index + 1] ?? 0
      const blue = pixels[index + 2] ?? 0
      if (Math.max(red, green, blue) > 90 && Math.max(red, green, blue) - Math.min(red, green, blue) > 24) coloredPixels += 1
    }
    return coloredPixels
  }), { message: 'Canvas 应绘制可见的实体节点，而不是空白画布' }).toBeGreaterThan(20)

  const screenshotRoot = join(process.cwd(), 'artifacts', 'world-knowledge-graph')
  await mkdir(screenshotRoot, { recursive: true })
  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const panel = page.locator('.knowledge-graph').first()
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: join(screenshotRoot, `knowledge-graph-${viewport.label}.png`), fullPage: false })
  }

  await current.close()
  await startServer(false)
  const afterRestart = await getGraph(world.id)
  expect(afterRestart.entities).toHaveLength(graph.entities.length)
  expect(requireServer().store.doctor().ok).toBe(true)
  await writeFile(join(screenshotRoot, 'console.log'), consoleIssues.length === 0 ? 'No console errors or warnings.\n' : `${consoleIssues.join('\n')}\n`, 'utf8')
  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

async function startServer(bootstrapDefaultWorld: boolean): Promise<void> {
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld,
    knowledgeExtractionPort: new DeterministicKnowledgeExtractor(),
  })
  origin = (await server.start()).origin
}

async function expectGraph(worldId: string): Promise<GraphResponse> {
  let graph: GraphResponse = { entities: [], claims: [], relations: [], evidence: [] }
  await expect.poll(async () => {
    graph = await getGraph(worldId)
    return graph.claims.length
  }, { timeout: 8_000 }).toBeGreaterThan(0)
  return graph
}

async function getGraph(worldId: string): Promise<GraphResponse> {
  const response = await fetch(`${origin}/api/worlds/${worldId}/knowledge/graph?limit=300`)
  if (!response.ok) throw new Error(`图谱接口返回 ${response.status}: ${await response.text()}`)
  return await response.json() as GraphResponse
}

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('知识图谱 E2E 服务尚未启动')
  return server
}

function attachConsoleRecorder(page: Page, issues: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(`[console:${message.type()}] ${message.text()}`)
  })
  page.on('pageerror', (error) => issues.push(`[pageerror] ${error.message}`))
}

interface GraphResponse {
  entities: Array<{ id: string; canonicalName: string }>
  claims: Array<{ id: string }>
  relations: Array<{ id: string }>
  evidence: Array<{ id: string; messageId?: string; sourceType: string }>
}

class DeterministicKnowledgeExtractor implements KnowledgeExtractionPort {
  async extract(input: KnowledgeExtractionRequest) {
    const evidenceId = input.evidence[0]?.evidenceId
    if (evidenceId === undefined) return { payload: { entities: [], claims: [], relations: [], evidenceRefs: [] } }
    const evidenceRefs = [{ sourceType: input.sourceType, sourceId: input.sourceId, evidenceId }]
    return {
      payload: {
        entities: [
          { key: 'project', type: 'project', canonicalName: '北极星计划', aliases: [], evidenceRefs: [evidenceId] },
          { key: 'database', type: 'technology', canonicalName: 'SQLite', aliases: [], evidenceRefs: [evidenceId] },
        ],
        claims: [{ key: 'authority', type: 'fact', subjectKey: 'project', predicate: '使用本地权威数据源', objectKey: 'database', confidence: 0.98, evidenceRefs: [evidenceId] }],
        relations: [{ key: 'uses', fromKey: 'project', toKey: 'database', predicate: '使用', confidence: 0.98, evidenceRefs: [evidenceId] }],
        evidenceRefs,
      },
      usage: { model: 'deterministic-test', inputTokens: 12, outputTokens: 8 },
    }
  }
}
