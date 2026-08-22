import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type {
  AgentRuntimePort,
  AgentTurnRequest,
} from '../packages/contracts/lib/index.js'
import { WorldSimulationStore } from '../packages/persistence/lib/index.js'
import { createCyberServer, type CyberServer } from '../packages/server/lib/index.js'

let server: CyberServer
let origin: string
let stateRoot: string

test.beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-delegated-e2e-'))
  server = await createCyberServer({
    stateRoot,
    workspacePath: process.cwd(),
    webRoot: join(process.cwd(), 'packages', 'web', 'dist'),
    port: 0,
    runtime: new DelegatedWorkflowRuntime(),
  })
  origin = (await server.start()).origin
})

test.afterAll(async () => {
  await server.close()
  await rm(stateRoot, { recursive: true, force: true })
})

test('lets the user delegate a real role consultation and receive a grounded report in the original chat', async ({ page }) => {
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
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.fill('请帮我向 @阿帆 确认当前项目进度，然后回来告诉我。')
  await page.getByRole('button', { name: '发送' }).click()

  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employees = server.store.listEmployees(world.id)
  const butler = employees.find((employee) => employee.displayName === '管家')!
  const engineer = employees.find((employee) => employee.displayName === '阿帆')!

  await expect.poll(async () => {
    const snapshot = await (await fetch(`${origin}/api/worlds/${world.id}/runtime-snapshot`)).json() as {
      entities: Array<{ id: string; visualState: Record<string, unknown> }>
    }
    const states = Object.fromEntries(
      snapshot.entities.map((entity) => [entity.id, entity.visualState.physicalState]),
    )
    return [states[butler.id], states[engineer.id]].some((state) =>
      state === 'speaking' || state === 'thinking' || state === 'listening')
  }, { timeout: 8_000 }).toBe(true)

  await expect(page.locator('.message__content').getByText(
    /我已经向阿帆确认：接口层已完成，剩余端到端验证/,
  )).toBeVisible({ timeout: 20_000 })

  const sessions = server.store.listSessions(world.id)
  const direct = sessions.find((session) => session.kind === 'direct')!
  const meeting = sessions.find((session) => session.kind === 'meeting')!
  expect(direct).toBeDefined()
  expect(meeting).toBeDefined()

  const directMessages = server.store.listMessages(direct.id)
  const ownerMessage = directMessages.find((message) => message.kind === 'user')!
  expect(ownerMessage.content).toBe('请帮我向 @阿帆 确认当前项目进度，然后回来告诉我。')
  expect(ownerMessage.metadata).toMatchObject({
    delegatedWorkflow: true,
    delegatedPeerSessionId: meeting.id,
    delegatedParticipantIds: [butler.id, engineer.id],
  })
  expect(directMessages.find((message) => message.kind === 'assistant')).toMatchObject({
    senderId: butler.id,
    content: expect.stringContaining('我已经向阿帆确认'),
  })

  const peerParticipants = server.store.listParticipants(meeting.id)
  expect(peerParticipants.map((participant) => participant.participantId).sort()).toEqual([
    butler.id,
    engineer.id,
  ].sort())
  expect(peerParticipants.some((participant) => participant.kind === 'owner')).toBe(false)
  const peerMessages = server.store.listMessages(meeting.id)
  expect(peerMessages.filter((message) => message.kind === 'assistant').map((message) => message.senderId)).toEqual([
    engineer.id,
    butler.id,
  ])
  expect(peerMessages.at(-1)?.metadata).toMatchObject({
    delegatedDirectSessionId: direct.id,
  })

  const simulation = new WorldSimulationStore(server.store)
  const episode = simulation.listSharedEpisodes(world.id)[0]!
  expect(episode.sessionId).toBe(meeting.id)
  expect(ownerMessage.metadata.delegatedEpisodeId).toBe(episode.id)
  expect(server.store.listEmployeeRelationships(butler.id)[0]).toMatchObject({
    colleagueId: engineer.id,
    collaborationCount: 1,
  })

  const finalSnapshot = await (await fetch(`${origin}/api/worlds/${world.id}/runtime-snapshot`)).json() as {
    entities: Array<{ visualState: Record<string, unknown> }>
  }
  expect(finalSnapshot.entities.every((entity) => entity.visualState.activeMeetingId === undefined)).toBe(true)
})

class DelegatedWorkflowRuntime implements AgentRuntimePort {
  readonly turns = new Map<string, number>()

  async runTurn(request: AgentTurnRequest) {
    const turn = (this.turns.get(request.agent.id) ?? 0) + 1
    this.turns.set(request.agent.id, turn)
    const isReport = request.prompt.includes('[系统已完成一次真实角色协作]')
    const content = request.agent.displayName === '阿帆'
      ? '阿帆确认：接口层已完成，剩余端到端验证。'
      : isReport
        ? '我已经向阿帆确认：接口层已完成，剩余端到端验证。下一步应完成端到端测试。'
        : '管家已听取阿帆的进度，并整理了需要向用户汇报的结论。'
    const agentSessionId = request.agent.agentSessionId ?? `agent-${request.agent.id}`
    const events = [
      { kind: 'turn.started', sourceSequence: 1 },
      { kind: 'assistant.reasoning', sourceSequence: 2, content: '正在核对真实协作记录。' },
      { kind: 'assistant.message', sourceSequence: 3, content },
      { kind: 'turn.completed', sourceSequence: 4 },
    ] as const
    for (const event of events) {
      request.onEvent?.({
        ...event,
        source: 'delegated-e2e',
        sourceSessionId: agentSessionId,
        metadata: {},
      })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 90))
    }
    return { agentSessionId, finalResponse: content, eventCount: events.length }
  }

  async close(): Promise<void> {}
}
