import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { EmployeeActivityProjectionService } from '../src/services/employee-activity-projection-service.js'
import { TaskScheduleService } from '../src/services/task-schedule-service.js'
import type { WorldSettingsService } from '../src/services/world-settings-service.js'

const stores: SqliteStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('TaskScheduleService', () => {
  it('persists schedules and records an idempotent real run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-schedule-'))
    const databasePath = join(directory, 'cyber.sqlite')
    const store = await SqliteStore.open(databasePath)
    stores.push(store)
    for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
    const workspace = store.createWorkspace({ name: '计划测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '测试世界', templateId: 'cyber-company' })
    const blueprint = BUILTIN_BLUEPRINTS[0]!
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: blueprint.version })
    let turns = 0
    const orchestrator = {
      async direct(input: { prompt: string }) {
        turns += 1
        const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: '计划执行' })
        store.appendMessage({ sessionId: session.id, senderId: 'owner', senderKind: 'owner', kind: 'user', content: input.prompt, metadata: { interactionKind: 'task' } })
        store.appendMessage({ sessionId: session.id, senderId: employee.id, senderKind: 'employee', kind: 'assistant', content: '计划交付已经完成。', metadata: { traceTurnId: 'scheduled-turn' } })
        store.appendDomainEvent({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, type: 'turn.completed', actorId: employee.id, actorKind: 'employee', payload: { traceTurnId: 'scheduled-turn' } })
        return { session, replies: [{ employeeId: employee.id, displayName: employee.displayName, agentSessionId: 'scheduled-session', content: '计划交付已经完成。' }] }
      },
    } as unknown as ConversationOrchestrator
    const settings = { async composeRuntimePrompt(_worldId: string, _employee: unknown, prompt: string) { return prompt } } as unknown as WorldSettingsService
    const service = new TaskScheduleService({ store, orchestrator, settings, employeeActivity: new EmployeeActivityProjectionService(store) })
    const schedule = service.create({ worldId: world.id, employeeId: employee.id, title: '整理日报', prompt: '整理今天的交付', kind: 'once', scheduledAt: new Date(Date.now() + 60_000).toISOString(), permissionMode: 'workspace-write' })

    expect(service.list(world.id)).toEqual([schedule])
    const [run, duplicate] = await Promise.all([service.runNow(world.id, schedule.id), service.runNow(world.id, schedule.id)])
    expect(run).toMatchObject({ status: 'completed', scheduleId: schedule.id })
    expect(duplicate.id).toBe(run.id)
    expect(turns).toBe(1)
    expect(service.list(world.id)[0]).toMatchObject({ status: 'completed' })
    expect(store.getEmployeeDossier(employee.id).milestones[0]?.title).toContain('完成任务')

    store.close(); stores.splice(0)
    const reopened = await SqliteStore.open(databasePath)
    stores.push(reopened)
    const restored = new TaskScheduleService({ store: reopened, orchestrator, settings, employeeActivity: new EmployeeActivityProjectionService(reopened) })
    expect(restored.list(world.id)[0]).toMatchObject({ id: schedule.id, status: 'completed' })
    expect(restored.listRuns(schedule.id)).toHaveLength(1)
  })

  it('rejects unsafe permissions and intervals shorter than five minutes at the contract boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-schedule-guard-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite')); stores.push(store)
    for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
    const workspace = store.createWorkspace({ name: '计划权限测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '测试世界', templateId: 'cyber-company' })
    const blueprint = BUILTIN_BLUEPRINTS[0]!
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: blueprint.version })
    const service = new TaskScheduleService({ store, orchestrator: {} as ConversationOrchestrator, settings: {} as WorldSettingsService, employeeActivity: new EmployeeActivityProjectionService(store) })
    expect(() => service.create({ worldId: world.id, employeeId: employee.id, title: '过密计划', prompt: '执行', kind: 'interval', scheduledAt: new Date(Date.now() + 60_000).toISOString(), everySeconds: 60, permissionMode: 'read-only' })).toThrow('5 分钟')
  })
})
