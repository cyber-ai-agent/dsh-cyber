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
      async continueDirect(input: { workTurnId: string; employeeId: string; runtimePrompt: string }) {
        turns += 1
        const turn = store.getWorkTurn(input.workTurnId)
        expect(turn).toMatchObject({ status: 'running' })
        const session = store.getSession(turn!.sessionId)!
        store.appendMessage({ sessionId: session.id, senderId: input.employeeId, senderKind: 'employee', kind: 'assistant', content: '计划交付已经完成。', metadata: { traceTurnId: 'scheduled-turn', workTurnId: input.workTurnId } })
        store.appendDomainEvent({ workspaceId: workspace.id, worldId: world.id, sessionId: session.id, type: 'turn.completed', actorId: input.employeeId, actorKind: 'employee', payload: { traceTurnId: 'scheduled-turn', workTurnId: input.workTurnId } })
        store.completeWorkTurn(input.workTurnId)
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
    expect(run.workTurnId).toBeDefined()
    expect(store.getWorkTurn(run.workTurnId!)).toMatchObject({ id: run.workTurnId, status: 'completed' })
    expect(store.listSessionTurns(run.sessionId!)).toHaveLength(1)
    expect(store.listMessages(run.sessionId!).filter((message) => message.kind === 'user')).toHaveLength(1)
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

  it('atomically claims one scheduled occurrence with its optional queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-schedule-claim-'))
    const databasePath = join(directory, 'cyber.sqlite')
    const store = await SqliteStore.open(databasePath); stores.push(store)
    for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
    const workspace = store.createWorkspace({ name: '计划原子提交测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '测试世界', templateId: 'cyber-company' })
    const blueprint = BUILTIN_BLUEPRINTS[0]!
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: blueprint.version })
    const settings = { async composeRuntimePrompt(_worldId: string, _employee: unknown, prompt: string) { return prompt } } as unknown as WorldSettingsService
    const service = new TaskScheduleService({ store, orchestrator: {} as ConversationOrchestrator, settings, employeeActivity: new EmployeeActivityProjectionService(store) })
    const schedule = service.create({ worldId: world.id, employeeId: employee.id, title: '原子提交', prompt: '只创建一次 WorkTurn', kind: 'once', scheduledAt: new Date(Date.now() + 60_000).toISOString(), permissionMode: 'workspace-write' })
    const input = {
      scheduleId: schedule.id,
      scheduledFor: schedule.scheduledAt,
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: employee.id,
      title: schedule.title,
      prompt: schedule.prompt,
      permissionMode: schedule.permissionMode,
      queue: { id: 'schedule-queue-once', queueMode: 'normal' as const },
    }
    const created = store.claimTaskScheduleRun(input)
    expect(created).toMatchObject({ created: true, run: { scheduleId: schedule.id, workTurnId: expect.any(String), sessionId: expect.any(String) } })
    expect(created.queueEntry).toMatchObject({ workTurnId: created.run.workTurnId, status: 'queued' })

    const reopened = await SqliteStore.open(databasePath); stores.push(reopened)
    const replay = reopened.claimTaskScheduleRun(input)
    expect(replay.created).toBe(false)
    expect(replay.run.id).toBe(created.run.id)
    expect(replay.run.workTurnId).toBe(created.run.workTurnId)
    expect(replay.queueEntry?.id).toBe(created.queueEntry?.id)
    expect(reopened.database.prepare('SELECT COUNT(*) AS count FROM task_schedule_runs').get()).toMatchObject({ count: 1 })
    expect(reopened.listSessionTurns(created.run.sessionId!)).toHaveLength(1)
    expect(reopened.listMessages(created.run.sessionId!).filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(reopened.listConversationQueue(world.id)).toHaveLength(1)
  })

  it('interrupts a claimed occurrence on restart without replaying its WorkTurn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-schedule-recovery-'))
    const store = await SqliteStore.open(join(directory, 'cyber.sqlite')); stores.push(store)
    for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
    const workspace = store.createWorkspace({ name: '计划恢复测试' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '测试世界', templateId: 'cyber-company' })
    const blueprint = BUILTIN_BLUEPRINTS[0]!
    const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: blueprint.version })
    const settings = { async composeRuntimePrompt(_worldId: string, _employee: unknown, prompt: string) { return prompt } } as unknown as WorldSettingsService
    const service = new TaskScheduleService({ store, orchestrator: {} as ConversationOrchestrator, settings, employeeActivity: new EmployeeActivityProjectionService(store) })
    const schedule = service.create({ worldId: world.id, employeeId: employee.id, title: '恢复一次', prompt: '只执行一次', kind: 'once', scheduledAt: new Date(Date.now() + 60_000).toISOString(), permissionMode: 'read-only' })
    const claim = store.claimTaskScheduleRun({
      scheduleId: schedule.id,
      scheduledFor: schedule.scheduledAt,
      workspaceId: workspace.id,
      worldId: world.id,
      employeeId: employee.id,
      title: schedule.title,
      prompt: schedule.prompt,
      permissionMode: schedule.permissionMode,
    })
    expect(claim.created).toBe(true)
    store.startWorkTurn(claim.run.workTurnId!)

    const recovered = new TaskScheduleService({ store, orchestrator: {} as ConversationOrchestrator, settings, employeeActivity: new EmployeeActivityProjectionService(store) })
    expect(recovered.listRuns(schedule.id)[0]).toMatchObject({ status: 'failed', errorCode: 'service-restarted', workTurnId: claim.run.workTurnId })
    expect(store.getWorkTurn(claim.run.workTurnId!)).toMatchObject({ status: 'interrupted', errorCode: 'service-restarted' })
    await recovered.runDue()
    expect(recovered.listRuns(schedule.id)).toHaveLength(1)
  })
})
