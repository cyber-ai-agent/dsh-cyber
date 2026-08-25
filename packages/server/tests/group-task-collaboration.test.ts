import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class RecordingRuntime implements AgentRuntimePort {
  readonly calls: AgentTurnRequest[] = []

  async runTurn(request: AgentTurnRequest) {
    this.calls.push(request)
    return {
      agentSessionId: `agent-${request.agent.id}`,
      finalResponse: `${request.agent.displayName}完成了分配步骤。`,
      eventCount: 0,
    }
  }

  async close(): Promise<void> {}
}

async function start() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-group-task-'))
  roots.push(stateRoot)
  const runtime = new RecordingRuntime()
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime,
    bootstrapDefaultWorld: true,
  })
  servers.push(server)
  const address = await server.start()
  const workspace = server.store.listWorkspaces()[0]!
  const world = server.store.listWorlds(workspace.id)[0]!
  return { origin: address.origin, server, runtime, world }
}

async function json(origin: string, path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${origin}${path}`, init)
  return { response, body: await response.json() }
}

function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

describe('Group Task Collaboration server flow', () => {
  it('routes three participants to the capable research/build roles and persists the plan', async () => {
    const { origin, server, runtime, world } = await start()
    const archivist = await json(origin, `/api/worlds/${world.id}/recruit`, post({ blueprintId: 'cyber-company.archivist', blueprintVersion: 1, displayName: '小刘' }))
    const engineer = await json(origin, `/api/worlds/${world.id}/recruit`, post({ blueprintId: 'cyber-company.software-engineer', blueprintVersion: 1, displayName: '老王' }))
    expect(archivist.response.status).toBe(201)
    expect(engineer.response.status).toBe(201)
    const butler = server.store.listEmployees(world.id).find((item) => item.blueprintId === 'core.butler')!
    const participantIds = [archivist.body.employee.id, engineer.body.employee.id, butler.id]

    const created = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({
      employeeIds: participantIds,
      title: '研究与页面协作',
      collaborationMode: 'task',
    }))
    expect(created.response.status).toBe(201)
    expect(created.body.session.collaborationMode).toBe('task')

    const result = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: participantIds,
      sessionId: created.body.session.id,
      collaborationMode: 'task',
      interactionKind: 'task',
      prompt: '请搜索官网资料，然后制作一个 HTML 对比页',
    }))
    expect(result.response.status).toBe(200)
    expect(result.body.collaborationMode).toBe('task')
    expect(result.body.requiredSkillIds).toEqual(
      result.body.assignments.flatMap((item: { requiredSkills: string[] }) => item.requiredSkills),
    )
    expect(result.body.assignments).toHaveLength(2)
    expect(result.body.assignments.map((item: { employeeIds: string[] }) => item.employeeIds[0])).toEqual(
      expect.arrayContaining([archivist.body.employee.id, engineer.body.employee.id]),
    )
    expect(result.body.assignments.flatMap((item: { employeeIds: string[] }) => item.employeeIds)).not.toContain(butler.id)
    expect(runtime.calls.map((call) => call.agent.id)).not.toContain(butler.id)
    expect(result.body.plan.steps[1].dependsOn).toEqual([result.body.plan.steps[0].id])

    const plan = await json(origin, `/api/turns/${result.body.workTurnId}/collaboration-plan`)
    expect(plan.response.status).toBe(200)
    expect(plan.body.plan).toMatchObject({ id: result.body.plan.id, status: 'completed' })
    expect(plan.body.skillLabels).toMatchObject({ coding: '软件实现' })

    const alias = await json(origin, `/api/sessions/${created.body.session.id}/task-plan`)
    expect(alias.response.status).toBe(200)
    expect(alias.body.plan.id).toBe(result.body.plan.id)
  })

  it('allows switching an open group mode through the server contract', async () => {
    const { origin, world } = await start()
    const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
    const firstId = snapshot.body.employees[0].id as string
    const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({ blueprintId: 'cyber-company.secretary', blueprintVersion: 1 }))
    expect(recruited.response.status).toBe(201)
    const created = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({
      employeeIds: [firstId, recruited.body.employee.id],
      collaborationMode: 'discussion',
    }))
    expect(created.response.status).toBe(201)
    const switched = await json(origin, `/api/sessions/${created.body.session.id}/collaboration-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collaborationMode: 'task' }),
    })
    expect(switched.response.status).toBe(200)
    expect(switched.body.session.collaborationMode).toBe('task')
    const emptyPlan = await json(origin, `/api/sessions/${created.body.session.id}/task-plan`)
    expect(emptyPlan.response.status).toBe(200)
    expect(emptyPlan.body.plan).toBeNull()
  })

  it('treats the persisted session mode as authoritative over chat hints', async () => {
    const { origin, world, runtime } = await start()
    const snapshot = await json(origin, `/api/worlds/${world.id}/snapshot`)
    const firstId = snapshot.body.employees[0].id as string
    const recruited = await json(origin, `/api/worlds/${world.id}/recruit`, post({ blueprintId: 'cyber-company.secretary', blueprintVersion: 1 }))
    expect(recruited.response.status).toBe(201)
    const participantIds = [firstId, recruited.body.employee.id as string]
    const discussion = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({
      employeeIds: participantIds,
      collaborationMode: 'discussion',
    }))
    expect(discussion.response.status).toBe(201)

    const mismatchedTask = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: participantIds,
      sessionId: discussion.body.session.id,
      collaborationMode: 'task',
      interactionKind: 'task',
      prompt: '不要改变会话模式',
    }))
    expect(mismatchedTask.response.status).toBe(409)
    expect(mismatchedTask.body.error.code).toBe('session_mode_mismatch')
    expect(runtime.calls).toHaveLength(0)

    // interactionKind alone cannot bypass the persisted discussion mode.
    const discussionTurn = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: participantIds,
      sessionId: discussion.body.session.id,
      interactionKind: 'task',
      prompt: '仍然按讨论模式执行',
    }))
    expect(discussionTurn.response.status).toBe(200)
    expect(discussionTurn.body.collaborationMode).toBeUndefined()
    const turns = await json(origin, `/api/sessions/${discussion.body.session.id}/turns`)
    expect(turns.response.status).toBe(200)
    expect(turns.body.items.at(-1).interactionKind).toBe('meeting')

    const task = await json(origin, `/api/worlds/${world.id}/group-sessions`, post({
      employeeIds: participantIds,
      collaborationMode: 'task',
    }))
    expect(task.response.status).toBe(201)
    const mismatchedDiscussion = await json(origin, `/api/worlds/${world.id}/chat`, post({
      employeeIds: participantIds,
      sessionId: task.body.session.id,
      collaborationMode: 'discussion',
      interactionKind: 'meeting',
      prompt: '不能临时切回讨论',
    }))
    expect(mismatchedDiscussion.response.status).toBe(409)
    expect(mismatchedDiscussion.body.error.code).toBe('session_mode_mismatch')
  })
})
