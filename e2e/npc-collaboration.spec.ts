import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { AgentRuntimePort, AgentTurnRequest } from '../packages/contracts/lib/index.js'
import { WorldSimulationStore } from '../packages/persistence/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer
let origin: string
let stateRoot: string

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-peer-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new SlowPeerRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('lets one embodied character consult another, shows the real exchange, and persists shared experience', async ({ page }) => {
  await page.goto(origin)
  await page.getByRole('button', { name: '创建我的世界' }).click()
  await expect(page.locator('.world-runtime-canvas')).toBeVisible()

  await page.locator('.left-pane').getByRole('button', { name: '添加角色' }).click()
  const market = page.getByRole('dialog', { name: '角色市场' })
  await market.getByRole('button', { name: /开发工程师 v1/ }).click()
  await market.getByRole('textbox', { name: '角色名字（可选）' }).fill('阿帆')
  await market.getByRole('button', { name: '确认添加' }).click()
  await expect(market).toBeHidden()

  await page.getByRole('button', { name: '与管家私聊' }).click()
  const characterMenu = page.getByLabel('管家情境操作')
  await expect(characterMenu).toBeVisible()
  await characterMenu.getByRole('button', { name: /让他去沟通/ }).click()

  const dialog = page.getByRole('dialog', { name: /让 管家 去沟通/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('阿帆')).toBeVisible()
  await dialog.getByRole('textbox', { name: '角色协作目标' }).fill('向开发工程师确认当前项目进度，并整理成可执行的汇报。')
  await dialog.getByRole('button', { name: '开始真实协作' }).click()

  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employees = server.store.listEmployees(world.id)
  const butler = employees.find((employee) => employee.displayName === '管家')!
  const engineer = employees.find((employee) => employee.displayName === '阿帆')!

  await expect.poll(async () => {
    const response = await fetch(`${origin}/api/worlds/${world.id}/runtime-snapshot`)
    const snapshot = await response.json() as {
      entities: Array<{ id: string; visualState: Record<string, unknown> }>
    }
    const states = Object.fromEntries(snapshot.entities.map((entity) => [entity.id, entity.visualState.physicalState]))
    return [states[butler.id], states[engineer.id]].some((state) =>
      state === 'speaking' || state === 'thinking' || state === 'listening')
  }, { timeout: 8_000 }).toBe(true)

  await expect(dialog).toBeHidden({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: /向开发工程师确认当前项目进度/ })).toBeVisible()
  await expect(page.locator('.message__content').getByText(/阿帆已核对自己的职责与进度/)).toBeVisible()
  await expect(page.locator('.message__content').getByText(/管家已整理讨论结论/)).toBeVisible()

  const meeting = server.store.listSessions(world.id).find((session) => session.kind === 'meeting')!
  const participants = server.store.listParticipants(meeting.id)
  expect(participants.map((participant) => participant.participantId).sort()).toEqual([butler.id, engineer.id].sort())
  expect(participants.some((participant) => participant.kind === 'owner')).toBe(false)
  expect(server.store.listMessages(meeting.id).filter((message) => message.kind === 'assistant').map((message) => message.senderId)).toEqual([
    engineer.id,
    butler.id,
  ])

  const events = server.store.listWorldDomainEvents(world.id).filter((event) => event.sessionId === meeting.id)
  expect(events.find((event) => event.type === 'meeting.started')?.payload).toMatchObject({
    peerConversation: true,
    initiatorId: butler.id,
  })
  expect(events.find((event) => event.type === 'meeting.finished')?.payload).toMatchObject({
    peerConversation: true,
    status: 'completed',
  })

  const simulation = new WorldSimulationStore(server.store)
  const episodes = simulation.listSharedEpisodes(world.id)
  expect(episodes).toHaveLength(1)
  expect(episodes[0]).toMatchObject({
    participantIds: [butler.id, engineer.id],
    sessionId: meeting.id,
    kind: 'collaboration',
  })
  expect(episodes[0]!.summary).toContain('阿帆')
  expect(episodes[0]!.summary).toContain('管家')
  expect(server.store.listEmployeeRelationships(butler.id)[0]).toMatchObject({
    colleagueId: engineer.id,
    collaborationCount: 1,
  })
  expect(server.store.listEmployeeRelationships(engineer.id)[0]).toMatchObject({
    colleagueId: butler.id,
    collaborationCount: 1,
  })

  const finalSnapshot = await (await fetch(`${origin}/api/worlds/${world.id}/runtime-snapshot`)).json() as {
    entities: Array<{ id: string; visualState: Record<string, unknown> }>
  }
  expect(finalSnapshot.entities.every((entity) => entity.visualState.activeMeetingId === undefined)).toBe(true)
  expect(new Set(finalSnapshot.entities.map((entity) => entity.visualState.currentSlotId ?? entity.visualState.reservedSlotId)).size).toBe(finalSnapshot.entities.length)
})

class SlowPeerRuntime implements AgentRuntimePort {
  readonly counts = new Map<string, number>()

  async runTurn(request: AgentTurnRequest) {
    const count = (this.counts.get(request.agent.id) ?? 0) + 1
    this.counts.set(request.agent.id, count)
    const isButler = request.agent.displayName === '管家'
    const content = isButler
      ? `管家已整理讨论结论：接口开发进度明确，下一步完成端到端验证。第 ${count} 次发言。`
      : `阿帆已核对自己的职责与进度：接口层已完成，剩余端到端验证。第 ${count} 次发言。`
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    const events = [
      { kind: 'turn.started', sourceSequence: 1 },
      { kind: 'assistant.reasoning', sourceSequence: 2, content: '正在核对可公开的事实与职责边界。' },
      { kind: 'tool.started', sourceSequence: 3, toolName: 'search_workspace', callId: `call-${request.agent.id}-${count}` },
      { kind: 'tool.completed', sourceSequence: 4, callId: `call-${request.agent.id}-${count}`, failed: false },
      { kind: 'assistant.message', sourceSequence: 5, content },
      { kind: 'turn.completed', sourceSequence: 6 },
    ] as const
    for (const event of events) {
      request.onEvent?.({ ...event, source: 'peer-browser-e2e', sourceSessionId: agentSessionId, metadata: {} })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 90))
    }
    return { agentSessionId, finalResponse: content, eventCount: events.length }
  }

  async close(): Promise<void> {}
}
