import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

/**
 * A chat turn that is still doing the work owns that work.
 *
 * The turn classified as an instruction is already running — files, skills,
 * whatever it was asked for. The draft it recorded points at that same turn, so
 * starting the task now runs identical work a second time, concurrently, with
 * real side effects. A warning in the panel cannot prevent that; only the
 * action boundary can, so the refusal lives in the service.
 */

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class QuietRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []
  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return { agentSessionId: `quiet-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已回复。`, eventCount: 0 }
  }
  async close(): Promise<void> {}
}

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-source-turn-guard-'))
  roots.push(stateRoot)
  const runtime = new QuietRuntime()
  const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, runtime })
  servers.push(server)
  const origin = (await server.start()).origin
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  const employee = server.store.listEmployees(world.id)[0]!
  const session = server.store.createSession({
    workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '私聊',
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employee.id, kind: 'employee' }],
  })
  return { server, origin, runtime, workspace, world, employee, session }
}

/** A task recorded from a conversation turn, with that turn left in `status`. */
function draftFromTurn(f: Awaited<ReturnType<typeof fixture>>, status: 'running' | 'completed') {
  const turn = f.server.store.createWorkTurn({
    workspaceId: f.workspace.id, worldId: f.world.id, sessionId: f.session.id, interactionKind: 'chat',
  })
  f.server.store.appendMessage({
    sessionId: f.session.id, senderId: 'owner', senderKind: 'owner', kind: 'user',
    content: '把上周的用户反馈整理成一份改进清单。', metadata: { workTurnId: turn.id },
  })
  f.server.store.startWorkTurn(turn.id)
  if (status === 'completed') f.server.store.completeWorkTurn(turn.id)
  return f.server.work.createFromSource({
    worldId: f.world.id, workTurnId: turn.id,
    title: '整理用户反馈改进清单', description: '汇总上周用户反馈，输出一份带优先级的改进清单。',
  }).task
}

describe('a draft cannot run while the turn that proposed it is still running', () => {
  it('refuses execute with a conflict and starts no run', async () => {
    const f = await fixture()
    const task = draftFromTurn(f, 'running')
    const runsBefore = f.server.store.listWorldAgentRuns(f.world.id).length

    await expect(f.server.work.execute(task.id, { employeeIds: [f.employee.id] }))
      .rejects.toMatchObject({ code: 'work_task_source_turn_unsettled' })

    // Nothing started: the task is untouched and no run appeared.
    const after = f.server.work.detail(task.id)
    expect(after.task.status).toBe('draft')
    expect(after.runs).toHaveLength(0)
    expect(f.server.store.listWorldAgentRuns(f.world.id)).toHaveLength(runsBefore)
    expect(f.runtime.requests).toHaveLength(0)
  })

  it('refuses the same thing at the HTTP boundary', async () => {
    const f = await fixture()
    const task = draftFromTurn(f, 'running')

    const response = await fetch(`${f.origin}/api/tasks/${task.id}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeIds: [f.employee.id] }),
    })
    expect(response.status).toBe(409)
    expect((await response.json()).error?.code).toBe('work_task_source_turn_unsettled')
    expect(f.server.work.detail(task.id).runs).toHaveLength(0)
    expect(f.runtime.requests).toHaveLength(0)
  })

  it('lets the owner run it once the source turn has settled', async () => {
    const f = await fixture()
    const task = draftFromTurn(f, 'completed')

    const executed = await f.server.work.execute(task.id, { employeeIds: [f.employee.id] })
    expect(executed.runs.length).toBeGreaterThan(0)
    expect(f.runtime.requests.length).toBeGreaterThan(0)
  })
})
