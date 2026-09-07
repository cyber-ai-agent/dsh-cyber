import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, WorkTaskDetail } from '@dsh-cyber/contracts'
import { WorldArtifactRepository } from '@dsh-cyber/persistence'
import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []; const roots: string[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'source-task-completion-')); roots.push(stateRoot)
  let calls = 0
  const runtime: AgentRuntimePort = { async runTurn(request) { calls++; return { agentSessionId: request.agent.id, finalResponse: '已保存的回复：优先修复任务状态关联。', eventCount: 0 } }, async close() {} }
  const options = { stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, runtime, conversationTaskIntent: { async classify() { return { title: '任务状态优化', description: '整理任务状态改进建议。', priority: 'normal' as const } } } }
  const server = await createCyberServer(options); servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!; const world = server.store.listWorlds(workspace.id)[0]!; const employee = server.store.listEmployees(world.id)[0]!
  const session = server.store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '任务来源', participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }] })
  const source = (status: 'queued' | 'running' | 'completed' = 'completed') => {
    const turn = server.store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'chat' })
    server.store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '整理建议', metadata: { workTurnId: turn.id } })
    if (status !== 'queued') server.store.startWorkTurn(turn.id)
    if (status === 'completed') server.store.completeWorkTurn(turn.id)
    const task = server.work.createFromSource({ worldId: world.id, workTurnId: turn.id, title: '来源任务', description: '来自对话的任务' }).task
    return { turn, task }
  }
  return { server, origin, workspace, world, employee, options, source, calls: () => calls }
}

describe('conversation task completion', () => {
  it('projects current source state into both board filtering and detail without inventing task runs', async () => {
    const f = await fixture(); const { task, turn } = f.source('queued')
    expect(f.server.work.detail(task.id).task.status).toBe('ready')
    f.server.store.startWorkTurn(turn.id)
    expect(f.server.work.list(f.world.id, 'running').map((item) => item.id)).toContain(task.id)
    expect(f.server.work.detail(task.id).task.status).toBe('running')
    f.server.store.completeWorkTurn(turn.id)
    expect(f.server.work.detail(task.id).task.status).toBe('waiting-review')
    expect(f.server.work.list(f.world.id, 'running')).toEqual([])
    expect(f.server.work.list(f.world.id, 'waiting-review')).toHaveLength(1)
    expect(f.server.work.detail(task.id).runs).toEqual([])
    expect(f.calls()).toBe(0)
  })

  it('shows exact saved replies, confirms once, survives restart and never invokes the runtime again', async () => {
    const f = await fixture()
    const response = await fetch(`${f.origin}/api/worlds/${f.world.id}/chat`, post({ employeeIds: [f.employee.id], prompt: '整理任务状态改进建议' }))
    expect(response.status).toBe(200)
    const reply = await response.json() as any; const taskId = reply.proposedTask.id
    const before = f.server.work.detail(taskId)
    expect(before.task.status).toBe('waiting-review')
    expect(before.sourceTurn?.results?.messages.map((message) => message.content)).toContain('已保存的回复：优先修复任务状态关联。')
    const count = f.calls()
    for (let i = 0; i < 2; i++) {
      const completion = await fetch(`${f.origin}/api/tasks/${taskId}/complete-source`, post({ sourceWorkTurnId: reply.workTurnId, confirmed: true }))
      expect(completion.status).toBe(200)
      expect(((await completion.json()) as WorkTaskDetail).task.status).toBe('completed')
    }
    expect(f.calls()).toBe(count)
    expect(f.server.work.detail(taskId).runs).toEqual([])
    expect(f.server.work.detail(taskId).deliverables).toEqual([])
    const events = f.server.store.database.prepare("SELECT * FROM domain_events WHERE type = 'work.task.source.confirmed'").all()
    expect(events).toHaveLength(1)
    await f.server.close(); servers.splice(servers.indexOf(f.server), 1)
    const restarted = await createCyberServer(f.options); servers.push(restarted)
    expect(restarted.work.detail(taskId).task.status).toBe('completed')
    expect(restarted.store.database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('rejects live source completion and cancellation, wrong source and unconfirmed requests', async () => {
    const f = await fixture(); const { task, turn } = f.source('running')
    const call = (body: unknown) => fetch(`${f.origin}/api/tasks/${task.id}/complete-source`, post(body))
    expect((await call({ confirmed: true, sourceWorkTurnId: turn.id })).status).toBe(409)
    expect((await call({ confirmed: true, sourceWorkTurnId: 'other-turn' })).status).toBe(409)
    expect((await call({ confirmed: false, sourceWorkTurnId: turn.id })).status).toBe(422)
    expect((await fetch(`${f.origin}/api/tasks/${task.id}/cancel`, post({}))).status).toBe(409)
    expect(f.server.work.detail(task.id).task.status).toBe('running')
    expect(f.calls()).toBe(0)
  })

  it('keeps interrupted source facts and accepts an explicit owner decision with a note after restart', async () => {
    const f = await fixture(); const { task, turn } = f.source('running')
    await f.server.close(); servers.splice(servers.indexOf(f.server), 1)
    const restarted = await createCyberServer(f.options); servers.push(restarted)
    expect(restarted.work.detail(task.id).task.status).toBe('recovery-required')
    expect(() => restarted.work.completeFromSource(task.id, { sourceWorkTurnId: turn.id, confirmed: true })).toThrow('请说明')
    const completed = restarted.work.completeFromSource(task.id, { sourceWorkTurnId: turn.id, confirmed: true, note: '图片已生成，已检查保存结果。' })
    expect(completed.task.status).toBe('completed')
    expect(completed.sourceTurn).toMatchObject({ status: 'interrupted', errorCode: 'service-restarted' })
    expect(completed.runs).toEqual([])
    expect(completed.growthEvidence).toEqual([])
  })

  it('does not let telemetry pruning reset an unconfirmed task, but permits pruning after confirmation', async () => {
    const f = await fixture(); const { task, turn } = f.source()
    f.server.store.pruneHistory({ before: '2999-01-01T00:00:00.000Z' })
    expect(f.server.work.detail(task.id).task.status).toBe('waiting-review')
    expect(f.server.store.getWorkTurn(turn.id)).toBeDefined()
    f.server.work.completeFromSource(task.id, { sourceWorkTurnId: turn.id, confirmed: true })
    f.server.store.pruneHistory({ before: '2999-01-01T00:00:00.000Z' })
    expect(f.server.store.getWorkTurn(turn.id)).toBeUndefined()
    expect(f.server.work.detail(task.id).task.status).toBe('completed')
  })

  it('keeps cancelled and explicitly executed tasks authoritative', async () => {
    const f = await fixture(); const first = f.source(); f.server.work.cancel(first.task.id)
    expect(f.server.work.detail(first.task.id).task.status).toBe('cancelled')
    expect(() => f.server.work.completeFromSource(first.task.id, { sourceWorkTurnId: first.turn.id, confirmed: true })).toThrow()
    const second = f.source()
    await f.server.work.execute(second.task.id, { employeeIds: [f.employee.id] })
    const before = f.server.work.detail(second.task.id)
    expect(before.runs.length).toBeGreaterThan(0)
    expect(() => f.server.work.completeFromSource(second.task.id, { sourceWorkTurnId: second.turn.id, confirmed: true })).toThrow('已有独立执行')
    expect(f.server.work.detail(second.task.id)).toEqual(before)
  })

  it('rolls back completion if its audit record cannot be written', async () => {
    const f = await fixture(); const { task, turn } = f.source()
    f.server.store.database.exec(`CREATE TEMP TRIGGER reject_confirmation BEFORE INSERT ON domain_events
      WHEN NEW.type = 'work.task.source.confirmed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`)
    expect(() => f.server.work.completeFromSource(task.id, { sourceWorkTurnId: turn.id, confirmed: true })).toThrow('audit unavailable')
    expect(f.server.work.detail(task.id).task.status).toBe('waiting-review')
    expect(f.server.store.database.prepare("SELECT count(*) AS total FROM domain_events WHERE type = 'work.task.source.confirmed'").get()).toMatchObject({ total: 0 })
  })

  it('links only the source turn exact messages and immutable artifact versions, with bounded previews', async () => {
    const f = await fixture(); const mine = f.source(); const other = f.source()
    const run = (turn: typeof mine.turn) => {
      const value = f.server.store.createAgentRun({ workspaceId: f.workspace.id, worldId: f.world.id, sessionId: turn.sessionId, turnId: turn.id, employeeId: f.employee.id, ordinal: 1 })
      f.server.store.startAgentRun(value.id); f.server.store.completeAgentRun(value.id)
      return value
    }
    const mineRun = run(mine.turn); const otherRun = run(other.turn)
    for (let i = 0; i < 10; i++) f.server.store.appendMessage({ sessionId: mine.turn.sessionId, senderId: f.employee.id, senderKind: 'employee', kind: 'assistant', content: `结果${i}:` + '正文'.repeat(2100), metadata: { workTurnId: mine.turn.id, agentRunId: mineRun.id } })
    f.server.store.appendMessage({ sessionId: mine.turn.sessionId, senderId: f.employee.id, senderKind: 'employee', kind: 'assistant', content: '不是这个回合的结果', metadata: { workTurnId: mine.turn.id, agentRunId: otherRun.id } })
    const repository = new WorldArtifactRepository(f.server.store.database)
    const input = { workspaceId: f.workspace.id, worldId: f.world.id, title: '同名结果', kind: 'image' as const, relativePath: 'exports/test.png', byteLength: 1, sha256: 'a'.repeat(64), createdByKind: 'employee' as const, createdById: f.employee.id, sessionId: mine.turn.sessionId }
    const first = repository.publish({ ...input, workTurnId: mine.turn.id, agentRunId: mineRun.id })
    repository.publish({ ...input, artifactId: first.artifact.id, relativePath: 'exports/test-v2.png', workTurnId: other.turn.id, agentRunId: otherRun.id })
    repository.publish({ ...input, workTurnId: other.turn.id, agentRunId: otherRun.id })
    const results = f.server.work.detail(mine.task.id).sourceTurn!.results!
    expect(results.messages).toHaveLength(8)
    expect(results.messages.every((message) => message.truncated && message.content.length === 4000)).toBe(true)
    expect(results.messages.some((message) => message.content.includes('不是这个回合'))).toBe(false)
    expect(results.hasMore).toBe(true)
    expect(results.artifacts).toEqual([{ artifactId: first.artifact.id, version: 1, title: '同名结果', kind: 'image' }])
  })

  it('preserves the owner confirmation note as durable audit when telemetry is pruned', async () => {
    const f = await fixture(); const { task, turn } = f.source('running')
    f.server.store.interruptWorkTurn(turn.id, 'service-restarted')
    f.server.work.completeFromSource(task.id, { sourceWorkTurnId: turn.id, confirmed: true, note: '已核对保存的图片' })
    f.server.store.pruneHistory({ before: '2999-01-01T00:00:00.000Z' })
    const events = f.server.store.listDomainEvents(f.workspace.id).filter((event) => event.type === 'work.task.source.confirmed')
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ taskId: task.id, sourceStatus: 'interrupted', note: '已核对保存的图片', completionKind: 'owner-confirmed' })
    expect(f.server.work.detail(task.id).task.status).toBe('completed')
  })

})
