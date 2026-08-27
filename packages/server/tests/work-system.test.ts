import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimePort, AgentTurnRequest, WorkTaskDetail } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Work System V1', () => {
  it('creates, executes, delivers, requests changes, versions immutably, accepts, and restores after restart', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-work-system-'))
    roots.push(stateRoot)
    const runtime = new WorkRuntime()
    const server = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, bootstrapDefaultWorld: true, runtime })
    servers.push(server)
    const origin = (await server.start()).origin
    const workspace = server.store.listWorkspaces()[0]!
    const world = server.store.listWorlds(workspace.id)[0]!
    const coordinator = server.store.listEmployees(world.id)[0]!
    const recruit = await post<{ employee: { id: string } }>(origin, `/api/worlds/${world.id}/recruit`, {
      blueprintId: 'cyber-company.software-engineer', blueprintVersion: 1, displayName: '交付工程师', skillGrants: ['coding', 'testing'],
    })
    expect(recruit.status).toBe(201)
    const engineerId = recruit.body.employee.id

    const created = await post<{ task: { id: string; status: string } }>(origin, `/api/worlds/${world.id}/tasks`, {
      title: '实现可靠任务闭环', description: '实现并测试一个可审阅的本地交付，输出真实产物。', priority: 'high', coordinatorEmployeeId: coordinator.id,
    })
    expect(created.status).toBe(201)
    expect(created.body.task.status).toBe('draft')

    const firstRun = await post<WorkTaskDetail>(origin, `/api/tasks/${created.body.task.id}/execute`, {
      employeeIds: [coordinator.id, engineerId], coordinatorEmployeeId: coordinator.id,
    })
    expect(firstRun.status).toBe(200)
    expect(firstRun.body.task).toMatchObject({ status: 'waiting-review', currentPlanRevision: 1 })
    expect(firstRun.body.plans).toHaveLength(1)
    expect(firstRun.body.assignments.length).toBeGreaterThan(0)
    expect(firstRun.body.runs[0]?.agentRunIds.length).toBeGreaterThan(0)
    expect(firstRun.body.assignments[0]?.assignmentReason).toMatchObject({ source: 'group-task-router' })

    const filesPath = join(stateRoot, 'worlds', world.id, 'files')
    await mkdir(filesPath, { recursive: true })
    await writeFile(join(filesPath, 'delivery.md'), '# 第一版交付\n', 'utf8')
    const firstArtifact = await server.artifacts.publishFromWorkspace({
      workspaceId: workspace.id, worldId: world.id, sourceRelativePath: 'delivery.md', title: '任务交付', kind: 'markdown',
      createdByKind: 'employee', createdById: engineerId, employeeId: engineerId,
      workTurnId: firstRun.body.runs[0]!.workTurnId, agentRunId: firstRun.body.runs[0]!.agentRunIds[0], idempotencyKey: 'work-system-v1-first',
    })
    const firstDelivery = await post<{ deliverable: { id: string; version: number } }>(origin, `/api/tasks/${created.body.task.id}/deliverables`, {
      taskRunId: firstRun.body.runs[0]!.id, submittedByEmployeeId: engineerId,
      artifactId: firstArtifact.artifact.id, artifactVersionId: firstArtifact.version.version,
      title: '第一版交付', summary: '完成初版实现与测试。', evidenceRefs: [`run:${firstRun.body.runs[0]!.id}`],
    })
    expect(firstDelivery.body.deliverable.version).toBe(1)
    const changes = await post<WorkTaskDetail>(origin, `/api/deliverables/${firstDelivery.body.deliverable.id}/reviews`, {
      decision: 'request-changes', feedback: '补充恢复验证并生成新的不可变版本。',
    })
    expect(changes.body.task.status).toBe('changes-requested')
    expect(changes.body.deliverables[0]?.status).toBe('changes-requested')

    const secondRun = { status: 200, body: await server.work.execute(created.body.task.id, {
      employeeIds: [coordinator.id, engineerId], coordinatorEmployeeId: coordinator.id,
    }) }
    expect(secondRun.status, JSON.stringify(secondRun.body)).toBe(200)
    expect(secondRun.body.task).toMatchObject({ status: 'waiting-review', currentPlanRevision: 2 })
    expect(secondRun.body.runs).toHaveLength(2)
    expect(runtime.requests.some((request) => request.prompt.includes('补充恢复验证'))).toBe(true)
    await writeFile(join(filesPath, 'delivery.md'), '# 第二版交付\n\n已补充恢复验证。\n', 'utf8')
    const secondArtifact = await server.artifacts.createVersion({
      workspaceId: workspace.id, worldId: world.id, sourceRelativePath: 'delivery.md', title: '任务交付', kind: 'markdown',
      artifactId: firstArtifact.artifact.id, createdByKind: 'employee', createdById: engineerId, employeeId: engineerId,
      workTurnId: secondRun.body.runs[1]!.workTurnId, agentRunId: secondRun.body.runs[1]!.agentRunIds[0], idempotencyKey: 'work-system-v1-second',
    })
    const secondDelivery = await post<{ deliverable: { id: string; version: number } }>(origin, `/api/tasks/${created.body.task.id}/deliverables`, {
      taskRunId: secondRun.body.runs[1]!.id, submittedByEmployeeId: engineerId,
      artifactId: secondArtifact.artifact.id, artifactVersionId: secondArtifact.version.version,
      title: '第二版交付', summary: '已补充恢复验证。', evidenceRefs: [`review:${changes.body.reviews[0]!.id}`],
    })
    expect(secondDelivery.body.deliverable.version).toBe(2)
    const accepted = await post<WorkTaskDetail>(origin, `/api/deliverables/${secondDelivery.body.deliverable.id}/reviews`, {
      decision: 'accept', feedback: '验收通过。',
    })
    expect(accepted.body.task.status).toBe('completed')
    expect(accepted.body.deliverables.map((item) => item.status)).toEqual(['superseded', 'accepted'])
    expect(accepted.body.reviews).toHaveLength(2)
    expect(accepted.body.growthEvidence).toEqual([expect.objectContaining({ outcome: 'accepted', employeeId: engineerId })])

    await server.close()
    servers.splice(servers.indexOf(server), 1)
    const reopened = await createCyberServer({ stateRoot, workspacePath: stateRoot, port: 0, runtime: new WorkRuntime() })
    servers.push(reopened)
    const reopenedOrigin = (await reopened.start()).origin
    const restored = await get<WorkTaskDetail>(reopenedOrigin, `/api/tasks/${created.body.task.id}`)
    expect(restored.task.status).toBe('completed')
    expect(restored.deliverables).toHaveLength(2)
    expect(restored.reviews).toHaveLength(2)
  }, 30_000)
})

class WorkRuntime implements AgentRuntimePort {
  requests: AgentTurnRequest[] = []
  async runTurn(request: AgentTurnRequest) {
    this.requests.push(request)
    return { agentSessionId: `work-${request.agent.id}`, finalResponse: `${request.agent.displayName} 已完成分配步骤。`, eventCount: 0 }
  }
  async close() {}
}

async function post<T>(origin: string, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as T }
}
async function get<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`)
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`)
  return response.json() as Promise<T>
}
