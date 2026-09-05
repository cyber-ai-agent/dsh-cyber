import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'
import { attachAppConsoleRecorder } from './console-test-helpers.js'
import { openDockTab } from './dock-test-helpers.js'

const REPLY = '# 本周复盘\n\n- 周一：整理调研材料\n- 周三：确认交付范围\n\n没有任何文件被执行生成，这只是一段回复。\n'
const DOCUMENT_TITLE = '本周复盘'

let server: CyberServer | undefined
let origin = ''
let stateRoot = ''

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-save-reply-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    bootstrapDefaultWorld: true,
    runtime: new TextOnlyRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server?.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('keeps a text-only reply as an owner-published document without claiming a run produced it', async ({ page }) => {
  test.setTimeout(120_000)
  const consoleIssues: string[] = []
  attachAppConsoleRecorder(page, consoleIssues)
  const screenshotRoot = join(process.cwd(), 'artifacts', 'save-reply-as-document')
  await mkdir(screenshotRoot, { recursive: true })

  await page.goto(origin)
  await expect(page.locator('.workbench-shell')).toBeVisible()
  const world = requireServer().store.listWorlds(requireServer().store.listWorkspaces()[0]!.id)[0]!

  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.fill('帮我复盘本周的工作。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('本周复盘').first()).toBeVisible()

  // The turn wrote no file at all: the reply is text, and the world knows it.
  expect(requireServer().artifacts.list(world.id)).toEqual([])

  const reply = page.locator('.message').filter({ hasText: '整理调研材料' }).last()
  await expect(reply).toBeVisible()
  await reply.click({ button: 'right' })
  const menu = page.getByRole('menu', { name: '消息操作' })
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: /将回复保存为文档/ }).click()
  await expect(page.getByText('已保存为文档').first()).toBeVisible()

  const dock = page.getByRole('region', { name: '世界与角色侧边栏' })
  await openDockTab(dock, '产物')
  const center = page.getByRole('region', { name: '世界产物中心' })
  await expect(center.getByRole('list', { name: '产物列表' })).toContainText(DOCUMENT_TITLE)
  await center.getByRole('button', { name: `打开产物 ${DOCUMENT_TITLE}` }).click()
  const detail = page.getByRole('region', { name: `${DOCUMENT_TITLE}产物详情` })
  await expect(detail).toBeVisible()
  await expect(detail.locator('.artifact-detail__evidence')).toHaveText('由你手动发布')
  await expect(detail.locator('.artifact-detail__evidence--proven')).toHaveCount(0)
  await expect(detail.locator('.artifact-markdown-reader')).toContainText('确认交付范围')

  const published = requireServer().artifacts.list(world.id)
  expect(published).toHaveLength(1)
  const versions = requireServer().artifacts.get(world.id, published[0]!.id).versions
  expect(versions[0]?.agentRunId).toBeUndefined()
  expect(versions[0]?.workTurnId).toBeUndefined()
  expect(requireServer().artifacts.listRunProvenance(world.id)).toEqual([])

  for (const viewport of [
    { width: 1_440, height: 900, label: '1440x900' },
    { width: 1_920, height: 1_080, label: '1920x1080' },
    { width: 3_840, height: 2_160, label: '3840x2160' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await expect(detail).toBeVisible()
    await page.screenshot({ path: join(screenshotRoot, `saved-reply-${viewport.label}.png`), fullPage: false })
  }

  // The action belongs to a character reply; the owner's own row keeps the
  // menu it always had and gains nothing that would misdescribe it.
  await page.setViewportSize({ width: 1_440, height: 900 })
  await detail.getByRole('button', { name: '返回产物' }).click()
  const ownerRow = page.locator('.message--owner').last()
  await ownerRow.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: '消息操作' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /将回复保存为文档/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  expect(consoleIssues, consoleIssues.join('\n')).toEqual([])
})

function requireServer(): CyberServer {
  if (server === undefined) throw new Error('Saved reply E2E server is not running')
  return server
}

/** A turn that answers in words only and writes nothing into the world. */
class TextOnlyRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    request.onEvent?.({ kind: 'turn.started', source: 'save-reply-e2e', sourceSessionId: agentSessionId, sourceSequence: 1, metadata: {} })
    request.onEvent?.({ kind: 'assistant.message', source: 'save-reply-e2e', sourceSessionId: agentSessionId, sourceSequence: 2, content: REPLY, metadata: {} })
    request.onEvent?.({ kind: 'turn.completed', source: 'save-reply-e2e', sourceSessionId: agentSessionId, sourceSequence: 3, metadata: {} })
    return { agentSessionId, finalResponse: REPLY, eventCount: 3 }
  }

  async close(): Promise<void> {}
}
