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

  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  await recruitRole(world.id, 'cyber-company.software-engineer', '阿帆')
  await page.reload()
  await expect(page.getByRole('button', { name: '与阿帆私聊' })).toBeVisible()

  await page.getByRole('button', { name: '与管家私聊' }).click()
  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })
  await composer.fill('请帮我向 @阿帆 确认当前项目进度，然后回来告诉我。')
  await page.getByRole('button', { name: '发送' }).click()

  const employees = server.store.listEmployees(world.id)
  const butler = employees.find((employee) => employee.displayName === '管家')!
  const engineer = employees.find((employee) => employee.displayName === '阿帆')!

  // `speaking` / `thinking` / `listening` are transient: on a loaded machine the
  // turn can finish between two polls, so waiting only for them makes this
  // assertion a coin flip. A durable agent run for either character is the same
  // fact — the world reflected real work — and cannot be missed by arriving
  // late.
  await expect.poll(async () => {
    const snapshot = await (await fetch(`${origin}/api/worlds/${world.id}/runtime-snapshot`)).json() as {
      entities: Array<{ id: string; visualState: Record<string, unknown> }>
    }
    const states = Object.fromEntries(
      snapshot.entities.map((entity) => [entity.id, entity.visualState.physicalState]),
    )
    const live = [states[butler.id], states[engineer.id]].some((state) =>
      state === 'speaking' || state === 'thinking' || state === 'listening')
    if (live) return true
    return server.store.listWorldAgentRuns(world.id)
      .some((run) => run.employeeId === butler.id || run.employeeId === engineer.id)
  }, { timeout: 8_000 }).toBe(true)

  await expect(page.locator('.message__content').getByText(
    /我已经向阿帆确认：接口层已完成，剩余端到端验证/,
  )).toBeVisible({ timeout: 20_000 })

  const sessions = server.store.listSessions(world.id)
  const direct = sessions.find((session) => session.kind === 'direct' && server.store.listParticipants(session.id).some((participant) => participant.participantId === butler.id))!
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
  // The delegation summary must be recorded and linked to the direct chat it
  // reports back into. Two things made this racy as a single positional
  // assertion: the reply reaches the page over the stream before the route
  // has finished writing the summary, and runtime-event rows from the agent
  // run can land after it. Poll for the fact, not for its position.
  await expect.poll(
    () => server.store.listMessages(meeting.id)
      .some((message) => message.metadata.delegatedDirectSessionId === direct.id),
    { timeout: 10_000, message: '协作会话中应记录一条指向原私聊的委托汇报' },
  ).toBe(true)

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

async function recruitRole(worldId: string, blueprintId: string, displayName: string): Promise<void> {
  const response = await fetch(`${origin}/api/worlds/${worldId}/recruit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blueprintId, blueprintVersion: 1, displayName }),
  })
  expect(response.ok, await response.text()).toBe(true)
}

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
