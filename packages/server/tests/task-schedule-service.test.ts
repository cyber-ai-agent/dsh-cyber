import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { EmployeeActivityProjectionService } from '../src/services/employee-activity-projection-service.js'
import { TaskScheduleService } from '../src/services/task-schedule-service.js'
import type { TurnAwareApprovalContinuationService } from '../src/services/turn-aware-approval-continuation-service.js'
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
    expect(run.acceptedAt).toEqual(expect.any(String))
    expect(run.startedAt).toEqual(expect.any(String))
    expect(Date.parse(run.startedAt!)).toBeGreaterThanOrEqual(Date.parse(run.acceptedAt))
    expect(duplicate.id).toBe(run.id)
    expect(turns).toBe(1)
    expect(run.workTurnId).toBeDefined()
    expect(store.getWorkTurn(run.workTurnId!)).toMatchObject({ id: run.workTurnId, status: 'completed' })
    expect(store.listSessionTurns(run.sessionId!)).toHaveLength(1)
    expect(store.listMessages(run.sessionId!).filter((message) => message.kind === 'user')).toHaveLength(1)
    expect(store.listDomainEvents(workspace.id)
      .filter((event) => event.payload.runId === run.id)
      .map((event) => event.type)).toEqual([
        'schedule.run.accepted',
        'schedule.run.started',
        'schedule.run.completed',
      ])
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
    expect(created.run.acceptedAt).toEqual(expect.any(String))
    expect(created.run.startedAt).toBeUndefined()
    expect(created.queueEntry).toMatchObject({ workTurnId: created.run.workTurnId, status: 'queued' })

    const claimedQueue = store.claimConversationQueueEntry({
      queueEntryId: created.queueEntry!.id,
      expectedRevision: created.queueEntry!.revision,
      leaseOwner: 'schedule-test-worker',
      leaseDurationMs: 30_000,
    })
    expect(claimedQueue).toMatchObject({ status: 'running', workTurnId: created.run.workTurnId })
    const started = store.database.prepare(
      'SELECT accepted_at, started_at FROM task_schedule_runs WHERE id = ?',
    ).get(created.run.id) as { accepted_at: string; started_at: string | null }
    expect(started.accepted_at).toBe(created.run.acceptedAt)
    expect(started.started_at).toEqual(expect.any(String))
    expect(Date.parse(started.started_at!)).toBeGreaterThanOrEqual(Date.parse(started.accepted_at))

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

  it('accepts independent due schedules without running them inline', async () => {
    const fixture = await createScheduleFixture('并发受理')
    let wakes = 0
    let inlineRuns = 0
    const queue = {
      wake() { wakes += 1 },
      async reconcileWaiting() { return 0 },
      async runEntryNow() { inlineRuns += 1; throw new Error('automatic schedules must use the shared dispatcher') },
    }
    const continuations = {
      async runQueuedDirect() { return undefined },
      setTurnSettledHandler() {},
    } as unknown as TurnAwareApprovalContinuationService
    const service = new TaskScheduleService({
      store: fixture.store,
      orchestrator: {} as ConversationOrchestrator,
      settings: fixture.settings,
      employeeActivity: new EmployeeActivityProjectionService(fixture.store),
      queue,
      continuations,
    })
    const first = service.create(scheduleInput(fixture, '长任务'))
    const second = service.create(scheduleInput(fixture, '独立任务'))
    const dueAt = new Date(Date.now() - 60_000).toISOString()
    fixture.store.database.prepare('UPDATE task_schedules SET next_run_at = ? WHERE id IN (?, ?)').run(dueAt, first.id, second.id)

    await service.runDue()

    expect(service.listRuns(first.id)).toHaveLength(1)
    expect(service.listRuns(second.id)).toHaveLength(1)
    expect(fixture.store.listConversationQueue(fixture.world.id, undefined, 'queued')).toHaveLength(2)
    expect(wakes).toBe(2)
    expect(inlineRuns).toBe(0)
  })

  it('coalesces missed interval occurrences and keeps the next instant in the future', async () => {
    const fixture = await createScheduleFixture('错过触发')
    const queue = { wake() {}, async reconcileWaiting() { return 0 }, async runEntryNow() { throw new Error('unexpected inline run') } }
    const continuations = { async runQueuedDirect() { return undefined }, setTurnSettledHandler() {} } as unknown as TurnAwareApprovalContinuationService
    const service = new TaskScheduleService({ store: fixture.store, orchestrator: {} as ConversationOrchestrator, settings: fixture.settings, employeeActivity: new EmployeeActivityProjectionService(fixture.store), queue, continuations })
    const schedule = service.create({ ...scheduleInput(fixture, '周期汇总'), kind: 'interval', everySeconds: 300 })
    const missedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString()
    fixture.store.database.prepare('UPDATE task_schedules SET next_run_at = ? WHERE id = ?').run(missedAt, schedule.id)
    await service.runDue()
    const [run] = service.listRuns(schedule.id)
    expect(run?.scheduledFor).toBe(missedAt)
    fixture.store.startWorkTurn(run!.workTurnId!)
    fixture.store.completeWorkTurn(run!.workTurnId!)

    await service.runDue()

    expect(service.listRuns(schedule.id)).toHaveLength(1)
    const updated = service.list(fixture.world.id).find((item) => item.id === schedule.id)!
    expect(updated.status).toBe('active')
    expect(new Date(updated.nextRunAt!).valueOf()).toBeGreaterThan(Date.now())
    expect((new Date(updated.nextRunAt!).valueOf() - new Date(missedAt).valueOf()) % 300_000).toBe(0)
  })

  it('validates IANA time zones while preserving the scheduled UTC instant', async () => {
    const fixture = await createScheduleFixture('跨时区')
    const service = new TaskScheduleService({ store: fixture.store, orchestrator: {} as ConversationOrchestrator, settings: fixture.settings, employeeActivity: new EmployeeActivityProjectionService(fixture.store) })
    const scheduledAt = new Date(Date.now() + 60_000).toISOString()
    const schedule = service.create({ ...scheduleInput(fixture, '纽约提醒'), scheduledAt, timeZone: 'America/New_York' })
    expect(schedule).toMatchObject({ scheduledAt, nextRunAt: scheduledAt, timeZone: 'America/New_York' })
    expect(() => service.create({ ...scheduleInput(fixture, '错误时区'), timeZone: 'Mars/Olympus_Mons' })).toThrow('时区无效')
  })

  it('bounds shutdown and marks an unresolved local execution as an unknown result', async () => {
    const fixture = await createScheduleFixture('关闭期限')
    const never = new Promise<never>(() => {})
    const orchestrator = { async continueDirect() { return never } } as unknown as ConversationOrchestrator
    const service = new TaskScheduleService({ store: fixture.store, orchestrator, settings: fixture.settings, employeeActivity: new EmployeeActivityProjectionService(fixture.store), closeDrainTimeoutMs: 10 })
    const schedule = service.create(scheduleInput(fixture, '不可取消执行'))
    void service.runNow(fixture.world.id, schedule.id)
    await expect.poll(() => service.listRuns(schedule.id)[0]?.status).toBe('running')

    await service.close()

    expect(service.listRuns(schedule.id)[0]).toMatchObject({ status: 'failed', errorCode: 'shutdown-timeout-unknown-result' })
    const workTurnId = service.listRuns(schedule.id)[0]!.workTurnId!
    expect(fixture.store.getWorkTurn(workTurnId)).toMatchObject({ status: 'interrupted', errorCode: 'shutdown-timeout-unknown-result' })
    const recovered = new TaskScheduleService({ store: fixture.store, orchestrator: {} as ConversationOrchestrator, settings: fixture.settings, employeeActivity: new EmployeeActivityProjectionService(fixture.store) })
    await recovered.runDue()
    expect(recovered.listRuns(schedule.id)).toHaveLength(1)
    await expect(service.runNow(fixture.world.id, schedule.id)).rejects.toThrow('调度器已关闭')
  })
})

async function createScheduleFixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-schedule-f09-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite')); stores.push(store)
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
  const workspace = store.createWorkspace({ name })
  const world = store.createWorld({ workspaceId: workspace.id, name: `${name}世界`, templateId: 'cyber-company' })
  const blueprint = BUILTIN_BLUEPRINTS[0]!
  const employee = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: blueprint.version })
  const settings = { async composeRuntimePrompt(_worldId: string, _employee: unknown, prompt: string) { return prompt } } as unknown as WorldSettingsService
  return { store, workspace, world, employee, settings }
}

function scheduleInput(fixture: Awaited<ReturnType<typeof createScheduleFixture>>, title: string) {
  return {
    worldId: fixture.world.id,
    employeeId: fixture.employee.id,
    title,
    prompt: `执行${title}`,
    kind: 'once' as const,
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    permissionMode: 'workspace-write' as const,
  }
}
