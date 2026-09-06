import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import { PersistenceError, SqliteStore, WorkSystemRepository } from '../src/index.js'

const stores: SqliteStore[] = []
const roots: string[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Task Center execution claims', () => {
  it('persists one TaskRun and WorkTurn before any AgentRun, and replays the same key', async () => {
    const fixture = await setup()
    const first = fixture.repository.beginExecution(input(fixture, 'run-1', 'a'.repeat(64)))

    expect(first.created).toBe(true)
    expect(first.taskRun).toMatchObject({ attempt: 1, status: 'running', agentRunIds: [], idempotencyKey: 'run-1', fingerprintSha256: 'a'.repeat(64) })
    expect(first.workTurn).toMatchObject({ id: first.taskRun.workTurnId, status: 'queued', interactionKind: 'task' })
    expect(first.ownerMessage.metadata).toMatchObject({ workTaskId: fixture.task.id, taskRunId: first.taskRun.id, workTurnId: first.workTurn.id })
    expect(fixture.store.listWorldAgentRuns(fixture.world.id)).toEqual([])
    expect(fixture.store.database.prepare('SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ?').get(fixture.task.id)).toMatchObject({ count: 1 })

    const replay = fixture.repository.beginExecution(input(fixture, 'run-1', 'a'.repeat(64)))
    expect(replay.created).toBe(false)
    expect(replay.taskRun.id).toBe(first.taskRun.id)
    expect(replay.workTurn.id).toBe(first.workTurn.id)
    expect(fixture.store.listSessions(fixture.world.id)).toHaveLength(1)
  })

  it('rejects a changed fingerprint, keeps failures, and gives a retry a new attempt and WorkTurn', async () => {
    const fixture = await setup()
    const first = fixture.repository.beginExecution(input(fixture, 'run-1', 'b'.repeat(64)))

    expect(() => fixture.repository.beginExecution(input(fixture, 'run-1', 'c'.repeat(64))))
      .toThrow('different fingerprint')
    const failed = fixture.repository.failExecution({ taskRunId: first.taskRun.id, errorCode: 'model-timeout' })
    expect(failed.task.status).toBe('failed')
    expect(failed.runs).toMatchObject([{ id: first.taskRun.id, attempt: 1, status: 'failed', errorCode: 'model-timeout', agentRunIds: [] }])
    expect(fixture.store.getWorkTurn(first.workTurn.id)).toMatchObject({ status: 'failed', errorCode: 'model-timeout' })

    const retry = fixture.repository.beginExecution(input(fixture, 'run-2', 'd'.repeat(64)))
    expect(retry.created).toBe(true)
    expect(retry.taskRun).toMatchObject({ attempt: 2, status: 'running', idempotencyKey: 'run-2' })
    expect(retry.workTurn.id).not.toBe(first.workTurn.id)
    expect(fixture.repository.detail(fixture.task.id).runs.map((run) => run.attempt)).toEqual([1, 2])
    expect(fixture.store.listSessions(fixture.world.id)).toHaveLength(2)
  })

  it('requires a fingerprint whenever an execution key is supplied', async () => {
    const fixture = await setup()
    expect(() => fixture.repository.beginExecution({ ...input(fixture, 'run-1', 'e'.repeat(64)), fingerprintSha256: undefined }))
      .toThrow(PersistenceError)
    expect(fixture.repository.detail(fixture.task.id).runs).toEqual([])
  })

  it('moves TaskRun, WorkTask and WorkTurn through one approval lifecycle', async () => {
    const fixture = await setup()
    const execution = fixture.repository.beginExecution(input(fixture, 'approval-run', 'f'.repeat(64)))
    fixture.store.startWorkTurn(execution.workTurn.id)

    const waiting = fixture.repository.waitExecutionForApproval(execution.taskRun.id)
    expect(waiting.task.status).toBe('waiting-approval')
    expect(waiting.runs[0]?.status).toBe('waiting-approval')
    expect(fixture.store.getWorkTurn(execution.workTurn.id)?.status).toBe('waiting-approval')

    fixture.store.resumeWorkTurnAfterApproval(execution.workTurn.id)
    const resumed = fixture.repository.resumeExecutionAfterApproval(execution.taskRun.id)
    expect(resumed.task.status).toBe('running')
    expect(resumed.runs[0]?.status).toBe('running')
    expect(fixture.store.getWorkTurn(execution.workTurn.id)?.status).toBe('running')
    expect(fixture.repository.getTaskExecution(execution.taskRun.id).workTurn.id).toBe(execution.workTurn.id)
  })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-execution-claim-'))
  roots.push(root)
  const store = await SqliteStore.open(join(root, 'task.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '任务执行' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '任务世界', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: 'task-execution.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '执行角色',
    role: '执行',
    summary: '任务执行测试角色',
    persona: '只按任务事实工作。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-09-06T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, displayName: '执行角色' })
  const repository = new WorkSystemRepository(store.database)
  const task = repository.createTask({
    workspaceId: workspace.id,
    worldId: world.id,
    title: '执行幂等测试',
    description: '验证事实前置。',
    priority: 'normal',
    createdBy: 'owner',
  })
  return { store, world, employee, repository, task }
}

function input(
  fixture: Awaited<ReturnType<typeof setup>>,
  idempotencyKey: string,
  fingerprintSha256: string,
) {
  return {
    taskId: fixture.task.id,
    workspaceId: fixture.task.workspaceId,
    worldId: fixture.task.worldId,
    employeeIds: [fixture.employee.id],
    coordinatorEmployeeId: fixture.employee.id,
    prompt: '执行幂等测试任务。',
    idempotencyKey,
    fingerprintSha256,
    steps: [{
      id: 'step-1',
      ordinal: 1,
      requiredSkills: [],
      assignedEmployeeIds: [fixture.employee.id],
      dependsOn: [],
      executionMode: 'parallel' as const,
    }],
  }
}
