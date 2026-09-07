import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Task Center execution idempotency', () => {
  it('returns the preclaimed run while a duplicate waits, and resumes the same WorkTurn', async () => {
    const runtime = new GatedRuntime()
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-execution-service-'))
    roots.push(root)
    const server = await createCyberServer({ stateRoot: root, workspacePath: root, port: 0, bootstrapDefaultWorld: true, runtime })
    servers.push(server)
    await server.start()
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const employee = server.store.listEmployees(world.id)[0]!
    const task = server.work.create({
      workspaceId: workspace.id,
      worldId: world.id,
      title: '幂等执行',
      description: '确认一个提交键只进入一次真实执行。',
      priority: 'normal',
    })
    const request = {
      employeeIds: [employee.id],
      idempotencyKey: 'task-execution-1',
    }

    const first = server.work.execute(task.id, request)
    await runtime.entered
    const running = server.work.detail(task.id)
    expect(running.task.status).toBe('running')
    expect(running.runs).toMatchObject([{ attempt: 1, status: 'running', agentRunIds: [] }])
    const workTurnId = running.runs[0]!.workTurnId
    expect(runtime.requests[0]?.workTurnId).toBe(workTurnId)

    const replay = await server.work.execute(task.id, request)
    expect(replay.runs[0]).toMatchObject({ workTurnId: workTurnId, status: 'running', agentRunIds: [] })
    expect(runtime.requests).toHaveLength(1)

    runtime.release()
    const completed = await first
    expect(completed.runs).toMatchObject([{ attempt: 1, status: 'completed', workTurnId: workTurnId }])
    expect(runtime.requests.every((item) => item.workTurnId === workTurnId)).toBe(true)
    await expect(server.work.execute(task.id, { ...request, employeeIds: [employee.id], coordinatorEmployeeId: 'different-employee' }))
      .rejects.toMatchObject({ code: 'task_execution_conflict', kind: 'conflict' })
  }, 30_000)
})

class GatedRuntime implements AgentRuntimePort {
  readonly requests: AgentTurnRequest[] = []
  readonly entered: Promise<void>
  #resolveEntered!: () => void
  #releaseGate!: () => void
  #gate = new Promise<void>((resolve) => { this.#releaseGate = resolve })

  constructor() {
    this.entered = new Promise<void>((resolve) => { this.#resolveEntered = resolve })
  }

  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    this.#resolveEntered()
    await this.#gate
    return { agentSessionId: `task-${request.agent.id}`, finalResponse: '已完成。', eventCount: 0 }
  }

  release(): void { this.#releaseGate() }
  async close(): Promise<void> { this.#releaseGate() }
}
