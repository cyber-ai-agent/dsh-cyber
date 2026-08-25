import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CYBER_SCHEMA_VERSION, type EmployeeBlueprint } from '@dsh-cyber/contracts'
import { afterEach, describe, expect, it } from 'vitest'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('TaskCollaborationPlan persistence', () => {
  it('defaults sessions to discussion and persists task mode and plans across restart', async () => {
    const { path, store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '协作工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '甲世界', templateId: 'cyber-company' })
    const employee = recruit(store, workspace.id, world.id, '甲员工')
    const discussion = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'group', title: '讨论' })
    const task = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'group', title: '任务', collaborationMode: 'task' })
    const direct = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '私聊' })
    const taskKind = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'task', title: '旧任务类型', collaborationMode: 'task' })
    expect(discussion.collaborationMode).toBe('discussion')
    expect(task.collaborationMode).toBe('task')
    expect(store.setSessionCollaborationMode(discussion.id, 'task').collaborationMode).toBe('task')
    expect(store.updateSessionCollaborationMode({ sessionId: discussion.id, collaborationMode: 'discussion' }).collaborationMode).toBe('discussion')
    expect(() => store.setSessionCollaborationMode(direct.id, 'task')).toThrow('Only group sessions')
    expect(() => store.setSessionCollaborationMode(taskKind.id, 'discussion')).toThrow('Only group sessions')
    const discussionTurn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: discussion.id, interactionKind: 'task' })
    expect(() => store.createTaskCollaborationPlan({
      taskId: 'discussion-is-not-task', workspaceId: workspace.id, worldId: world.id,
      sessionId: discussion.id, workTurnId: discussionTurn.id,
      steps: [{ requiredSkills: [], assignedEmployeeIds: [employee.id], dependsOn: [], executionMode: 'parallel' }],
    })).toThrow('requires a task group session')
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: task.id, interactionKind: 'task' })
    const plan = store.createTaskCollaborationPlan({
      taskId: 'task-website-analysis', workspaceId: workspace.id, worldId: world.id,
      sessionId: task.id, workTurnId: turn.id,
      steps: [
        { id: 'search', requiredSkills: ['web.search'], assignedEmployeeIds: [employee.id], dependsOn: [], executionMode: 'parallel', status: 'ready' },
        { id: 'build', requiredSkills: ['frontend.build'], assignedEmployeeIds: [employee.id], dependsOn: ['search'], executionMode: 'sequential' },
      ],
    })
    expect(plan).toMatchObject({
      taskId: 'task-website-analysis', worldId: world.id, sessionId: task.id, workTurnId: turn.id,
      revision: 1, status: 'planned', steps: [
        expect.objectContaining({ id: 'search', ordinal: 1, status: 'ready' }),
        expect.objectContaining({ id: 'build', ordinal: 2, dependsOn: ['search'], executionMode: 'sequential' }),
      ],
    })
    expect(store.getLatestTaskCollaborationPlanForSession(task.id)).toEqual(plan)
    expect(store.getLatestTaskCollaborationPlanForSession(discussion.id)).toBeUndefined()
    expect(store.getTaskCollaborationPlanByTurn(world.id, turn.id)).toEqual(plan)
    expect(() => store.getLatestTaskCollaborationPlanForSession('other-world', task.id))
      .toThrow('does not match its world')
    expect(store.createTaskCollaborationPlan({
      taskId: 'task-website-analysis', workspaceId: workspace.id, worldId: world.id,
      sessionId: task.id, workTurnId: turn.id, steps: plan.steps.map(stepInput),
    }).id).toBe(plan.id)

    const updated = store.updateTaskCollaborationPlan({ planId: plan.id, expectedRevision: 1, status: 'running' })
    expect(updated.revision).toBe(2)
    expect(updated.status).toBe('running')
    const stepUpdated = store.updateTaskCollaborationStep({
      planId: plan.id, stepId: 'search', expectedRevision: 2, status: 'running',
    })
    expect(stepUpdated.revision).toBe(3)
    expect(stepUpdated.steps.find((step) => step.id === 'search')?.status).toBe('running')
    expect(stepUpdated.steps.find((step) => step.id === 'search')?.createdAt)
      .toBe(plan.steps.find((step) => step.id === 'search')?.createdAt)
    expect(() => store.updateTaskCollaborationPlan({ planId: plan.id, expectedRevision: 1, status: 'completed' }))
      .toThrow('changed concurrently')
    expect(() => store.updateTaskCollaborationPlan({ planId: plan.id, expectedRevision: 3, status: 'completed' }))
      .toThrow('cannot contain unfinished steps')

    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = await SqliteStore.open(path)
    stores.push(reopened)
    expect(reopened.getSession(discussion.id)?.collaborationMode).toBe('discussion')
    expect(reopened.getSession(task.id)?.collaborationMode).toBe('task')
    expect(reopened.getTaskCollaborationPlan(plan.id)).toEqual(stepUpdated)
    expect(reopened.doctor()).toMatchObject({ schemaVersion: CYBER_SCHEMA_VERSION, counts: { taskCollaborationPlans: 1, taskCollaborationSteps: 2 } })
  })

  it('enforces world isolation and validates step dependencies and assignments', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '隔离工作区' })
    const worldA = store.createWorld({ workspaceId: workspace.id, name: '甲世界', templateId: 'cyber-company' })
    const worldB = store.createWorld({ workspaceId: workspace.id, name: '乙世界', templateId: 'cyber-company' })
    const employeeA = recruit(store, workspace.id, worldA.id, '甲员工')
    const employeeB = recruit(store, workspace.id, worldB.id, '乙员工')
    const sessionA = store.createSession({ workspaceId: workspace.id, worldId: worldA.id, kind: 'group', title: '甲任务', collaborationMode: 'task' })
    const sessionB = store.createSession({ workspaceId: workspace.id, worldId: worldB.id, kind: 'group', title: '乙任务', collaborationMode: 'task' })
    const turnA = store.createWorkTurn({ workspaceId: workspace.id, worldId: worldA.id, sessionId: sessionA.id, interactionKind: 'task' })
    const turnB = store.createWorkTurn({ workspaceId: workspace.id, worldId: worldB.id, sessionId: sessionB.id, interactionKind: 'task' })

    expect(() => store.createTaskCollaborationPlan({
      taskId: 'cross-world', workspaceId: workspace.id, worldId: worldA.id,
      sessionId: sessionB.id, workTurnId: turnB.id,
      steps: [{ requiredSkills: [], assignedEmployeeIds: [employeeA.id], dependsOn: [], executionMode: 'parallel' }],
    })).toThrow('does not match its world')
    expect(() => store.createTaskCollaborationPlan({
      taskId: 'wrong-assignee', workspaceId: workspace.id, worldId: worldA.id,
      sessionId: sessionA.id, workTurnId: turnA.id,
      steps: [{ requiredSkills: [], assignedEmployeeIds: [employeeB.id], dependsOn: [], executionMode: 'parallel' }],
    })).toThrow('does not belong to this world')
    expect(store.getTaskCollaborationPlanByTurn(worldA.id, turnB.id)).toBeUndefined()
    expect(store.getTaskCollaborationPlanByTurn(worldB.id, turnA.id)).toBeUndefined()
    expect(() => store.createTaskCollaborationPlan({
      taskId: 'missing-dependency', workspaceId: workspace.id, worldId: worldA.id,
      sessionId: sessionA.id, workTurnId: turnA.id,
      steps: [{ id: 'one', requiredSkills: [], assignedEmployeeIds: [employeeA.id], dependsOn: ['missing'], executionMode: 'parallel' }],
    })).toThrow('dependency is missing')
    expect(() => store.createTaskCollaborationPlan({
      taskId: 'cyclic-dependency', workspaceId: workspace.id, worldId: worldA.id,
      sessionId: sessionA.id, workTurnId: turnA.id,
      steps: [
        { id: 'one', requiredSkills: [], assignedEmployeeIds: [employeeA.id], dependsOn: ['two'], executionMode: 'parallel' },
        { id: 'two', requiredSkills: [], assignedEmployeeIds: [employeeA.id], dependsOn: ['one'], executionMode: 'parallel' },
      ],
    })).toThrow('contain a cycle')
  })

  it('recovers in-flight plans idempotently and keeps plans after work-turn pruning', async () => {
    const { store } = await testDatabase()
    const workspace = store.createWorkspace({ name: '恢复工作区' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '恢复世界', templateId: 'cyber-company' })
    const employee = recruit(store, workspace.id, world.id, '恢复员工')
    const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'group', title: '恢复任务', collaborationMode: 'task' })
    const turn = store.createWorkTurn({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, interactionKind: 'task' })
    const plan = store.createTaskCollaborationPlan({
      taskId: 'recover-me', workspaceId: workspace.id, worldId: world.id, sessionId: session.id, workTurnId: turn.id,
      status: 'running',
      steps: [
        { id: 'ready', requiredSkills: [], assignedEmployeeIds: [employee.id], dependsOn: [], executionMode: 'parallel', status: 'ready' },
        { id: 'running', requiredSkills: [], assignedEmployeeIds: [employee.id], dependsOn: ['ready'], executionMode: 'sequential', status: 'running' },
        { id: 'pending', requiredSkills: [], assignedEmployeeIds: [employee.id], dependsOn: ['running'], executionMode: 'sequential', status: 'pending' },
      ],
    })
    expect(() => store.updateTaskCollaborationPlan({ planId: plan.id, expectedRevision: 1, status: 'planned' }))
      .toThrow('Illegal task collaboration plan transition')
    expect(store.recoverTaskCollaborationPlansAfterRestart('2026-08-26T01:00:00.000Z')).toEqual({ plansInterrupted: 1, stepsInterrupted: 3 })
    expect(store.recoverTaskCollaborationPlansAfterRestart('2026-08-26T01:01:00.000Z')).toEqual({ plansInterrupted: 0, stepsInterrupted: 0 })
    const recovered = store.getTaskCollaborationPlan(plan.id)!
    expect(recovered.status).toBe('interrupted')
    expect(recovered.revision).toBe(2)
    expect(recovered.errorCode).toBe('service-restarted')
    expect(recovered.steps.find((step) => step.id === 'ready')?.status).toBe('interrupted')
    expect(recovered.steps.find((step) => step.id === 'running')?.status).toBe('interrupted')
    expect(recovered.steps.find((step) => step.id === 'pending')?.status).toBe('interrupted')
    expect(() => store.updateTaskCollaborationPlan({ planId: plan.id, expectedRevision: recovered.revision, status: 'running' }))
      .toThrow('Illegal task collaboration plan transition')
    expect(() => store.updateTaskCollaborationStep({ planId: plan.id, stepId: 'pending', expectedRevision: recovered.revision, status: 'pending' }))
      .toThrow('Terminal task collaboration plan')

    store.startWorkTurn(turn.id)
    store.completeWorkTurn(turn.id)
    store.pruneHistory({ before: '9999-01-01T00:00:00.000Z', workspaceId: workspace.id })
    expect(store.getTaskCollaborationPlan(plan.id)).toEqual(recovered)
  })
})

function stepInput(step: { id: string; requiredSkills: string[]; assignedEmployeeIds: string[]; dependsOn: string[]; executionMode: 'parallel' | 'sequential'; status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted' | 'cancelled'; errorCode?: string }) {
  return {
    id: step.id,
    requiredSkills: step.requiredSkills,
    assignedEmployeeIds: step.assignedEmployeeIds,
    dependsOn: step.dependsOn,
    executionMode: step.executionMode,
    status: step.status,
    ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
  }
}

function recruit(store: SqliteStore, workspaceId: string, worldId: string, displayName: string) {
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: `test.${worldId}.${displayName}`,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role: '协作角色',
    summary: '协作测试角色',
    persona: '保持当前世界边界。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-26T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  return store.recruitEmployee({ workspaceId, worldId, blueprintId: blueprint.id, blueprintVersion: 1, displayName })
}

async function testDatabase(): Promise<{ path: string; store: SqliteStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-collaboration-'))
  const path = join(root, 'cyber.sqlite')
  const store = await SqliteStore.open(path)
  stores.push(store)
  return { path, store }
}
