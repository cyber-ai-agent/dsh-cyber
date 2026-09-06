import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_BLUEPRINTS } from '@dsh-cyber/catalog'
import type { ConversationQueueEntry } from '@dsh-cyber/contracts'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import { SqliteStore } from '@dsh-cyber/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { ConversationQueueService } from '../src/services/conversation-queue-service.js'
import { EmployeeActivityProjectionService } from '../src/services/employee-activity-projection-service.js'
import { TaskScheduleService } from '../src/services/task-schedule-service.js'
import type { TurnAwareApprovalContinuationService } from '../src/services/turn-aware-approval-continuation-service.js'
import type { WorldSettingsService } from '../src/services/world-settings-service.js'

const roots: string[] = []
const stores: SqliteStore[] = []
const queues: ConversationQueueService[] = []
const releases = new Set<() => void>()
const runnerSettlements: Promise<unknown>[] = []

afterEach(async () => {
  for (const release of releases) release()
  releases.clear()
  await Promise.allSettled(runnerSettlements.splice(0))
  for (const queue of queues.splice(0)) await queue.close()
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('F09 dispatcher pressure and late runner boundaries', () => {
  it('claims and executes an independent automatic schedule while another schedule runner never returns', async () => {
    const fixture = await createScheduleFixture('自动计划压力')
    const hangingGate = deferred<void>()
    releases.add(() => hangingGate.resolve())
    const seen: string[] = []
    let hangingQueueId: string | undefined
    let independentQueueId: string | undefined
    let hangingReturned = false
    let independentReturned = false
    let settleWorkTurn: ((workTurnId: string) => Promise<void>) | undefined

    const queue = new ConversationQueueService({
      store: fixture.store,
      orchestrator: { interruptWorkTurn: async () => undefined } as unknown as ConversationOrchestrator,
      runner: trackedRunner(async (entry) => {
        seen.push(entry.id)
        if (entry.id === hangingQueueId) {
          await hangingGate.promise
          fixture.store.completeWorkTurn(entry.workTurnId)
          await settleWorkTurn?.(entry.workTurnId)
          hangingReturned = true
          return
        }
        expect(entry.id).toBe(independentQueueId)
        fixture.store.completeWorkTurn(entry.workTurnId)
        await settleWorkTurn?.(entry.workTurnId)
        independentReturned = true
      }),
      pollIntervalMs: 10_000,
    })
    queues.push(queue)

    const continuations = {
      async runQueuedDirect() { return undefined },
      setTurnSettledHandler(handler: (workTurnId: string) => Promise<void>) { settleWorkTurn = handler },
    } as unknown as TurnAwareApprovalContinuationService
    const service = new TaskScheduleService({
      store: fixture.store,
      orchestrator: {} as ConversationOrchestrator,
      settings: fixture.settings,
      employeeActivity: new EmployeeActivityProjectionService(fixture.store),
      queue,
      continuations,
    })
    const hangingSchedule = service.create(scheduleInput(fixture, fixture.employees[0]!.id, '不会返回的自动计划'))
    const independentSchedule = service.create(scheduleInput(fixture, fixture.employees[1]!.id, '独立自动计划'))
    const dueAt = new Date(Date.now() - 60_000).toISOString()
    fixture.store.database.prepare('UPDATE task_schedules SET next_run_at = ? WHERE id IN (?, ?)').run(
      dueAt,
      hangingSchedule.id,
      independentSchedule.id,
    )
    hangingQueueId = `schedule:${hangingSchedule.id}:${dueAt}:queue`
    independentQueueId = `schedule:${independentSchedule.id}:${dueAt}:queue`

    const startedAt = Date.now()
    await service.runDue()
    expect(Date.now() - startedAt).toBeLessThan(500)

    await waitFor(() => seen.includes(hangingQueueId!) && seen.includes(independentQueueId!))
    expect(hangingReturned).toBe(false)
    expect(independentReturned).toBe(true)
    expect(fixture.store.getConversationQueueEntry(hangingQueueId!)).toMatchObject({ status: 'running' })
    expect(fixture.store.getConversationQueueEntry(independentQueueId!)).toMatchObject({ status: 'completed' })
    expect(fixture.store.getWorkTurn(service.listRuns(hangingSchedule.id)[0]!.workTurnId!)).toMatchObject({ status: 'running' })
    expect(fixture.store.getWorkTurn(service.listRuns(independentSchedule.id)[0]!.workTurnId!)).toMatchObject({ status: 'completed' })
    expect(service.listRuns(independentSchedule.id)[0]).toMatchObject({ status: 'completed' })
    expect(service.listRuns(hangingSchedule.id)[0]).toMatchObject({ status: 'running' })
    const independentRun = service.listRuns(independentSchedule.id)[0]!
    expect(fixture.store.listDomainEvents(fixture.workspace.id)
      .filter((event) => event.payload.runId === independentRun.id)
      .map((event) => event.type)).toEqual([
        'schedule.run.accepted',
        'schedule.run.started',
        'schedule.run.completed',
      ])

    hangingGate.resolve()
    await waitFor(() => hangingReturned)
    await waitFor(() => service.listRuns(hangingSchedule.id)[0]?.status === 'completed')
    expect(fixture.store.getConversationQueueEntry(hangingQueueId!)).toMatchObject({ status: 'completed' })
    await queue.close()
  })

  it('keeps shutdown-timeout-unknown-result after a late runner settles', async () => {
    const fixture = await createQueueFixture('关闭晚到')
    const gate = deferred<void>()
    releases.add(() => gate.resolve())
    let runnerStarted = false
    let runnerReturned = false
    let lateMutation: 'rejected' | 'accepted' | undefined
    const runner = async (entry: ConversationQueueEntry) => {
      runnerStarted = true
      await gate.promise
      try {
        fixture.store.completeWorkTurn(entry.workTurnId)
        lateMutation = 'accepted'
      } catch {
        lateMutation = 'rejected'
      }
      runnerReturned = true
    }
    const queue = createQueue(fixture.store, runner, { closeDrainTimeoutMs: 10 })

    await queue.dispatchOnce()
    await waitFor(() => runnerStarted)
    await queue.close()

    expect(runnerReturned).toBe(false)
    expect(fixture.store.getConversationQueueEntry(fixture.entry.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'shutdown-timeout-unknown-result',
    })
    expect(fixture.store.getWorkTurn(fixture.entry.workTurnId)).toMatchObject({
      status: 'interrupted',
      errorCode: 'shutdown-timeout-unknown-result',
    })

    gate.resolve()
    await waitFor(() => runnerReturned)
    expect(lateMutation).toBe('rejected')
    expect(fixture.store.getConversationQueueEntry(fixture.entry.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'shutdown-timeout-unknown-result',
    })
    expect(fixture.store.getWorkTurn(fixture.entry.workTurnId)).toMatchObject({
      status: 'interrupted',
      errorCode: 'shutdown-timeout-unknown-result',
    })
  })

  it('keeps stop-timeout-unknown-result after a late runner settles', async () => {
    const fixture = await createQueueFixture('停止晚到')
    const gate = deferred<void>()
    releases.add(() => gate.resolve())
    let runnerStarted = false
    let runnerReturned = false
    let lateMutation: 'rejected' | 'accepted' | undefined
    const runner = async (entry: ConversationQueueEntry) => {
      runnerStarted = true
      await gate.promise
      try {
        fixture.store.completeWorkTurn(entry.workTurnId)
        lateMutation = 'accepted'
      } catch {
        lateMutation = 'rejected'
      }
      runnerReturned = true
    }
    const queue = createQueue(fixture.store, runner, { stopTimeoutMs: 10 })

    await queue.dispatchOnce()
    await waitFor(() => runnerStarted)
    const stopped = await queue.stop(fixture.entry.id)

    expect(runnerReturned).toBe(false)
    expect(stopped.entry).toMatchObject({
      status: 'interrupted',
      errorCode: 'stop-timeout-unknown-result',
    })
    expect(fixture.store.getConversationQueueEntry(fixture.entry.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'stop-timeout-unknown-result',
    })
    expect(fixture.store.getWorkTurn(fixture.entry.workTurnId)).toMatchObject({
      status: 'interrupted',
      errorCode: 'stop-timeout-unknown-result',
    })

    gate.resolve()
    await waitFor(() => runnerReturned)
    expect(lateMutation).toBe('rejected')
    expect(fixture.store.getConversationQueueEntry(fixture.entry.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'stop-timeout-unknown-result',
    })
    expect(fixture.store.getWorkTurn(fixture.entry.workTurnId)).toMatchObject({
      status: 'interrupted',
      errorCode: 'stop-timeout-unknown-result',
    })
    await queue.close()
  })
})

function createQueue(
  store: SqliteStore,
  runner: (entry: ConversationQueueEntry) => Promise<void>,
  options: { closeDrainTimeoutMs?: number; stopTimeoutMs?: number } = {},
): ConversationQueueService {
  const queue = new ConversationQueueService({
    store,
    orchestrator: { interruptWorkTurn: async () => new Promise<never>(() => {}) } as unknown as ConversationOrchestrator,
    runner: trackedRunner(runner),
    pollIntervalMs: 10_000,
    ...options,
  })
  queues.push(queue)
  return queue
}

async function createScheduleFixture(name: string) {
  const base = await createQueueFixture(name, 2)
  const settings = {
    async composeRuntimePrompt(_worldId: string, _employee: unknown, prompt: string) { return prompt },
  } as unknown as WorldSettingsService
  return { ...base, settings }
}

async function createQueueFixture(name: string, employeeCount = 1) {
  const stateRoot = await mkdtemp(join(tmpdir(), `dsh-f09-dispatcher-${name}-`))
  roots.push(stateRoot)
  const store = await SqliteStore.open(join(stateRoot, 'queue.sqlite'))
  stores.push(store)
  for (const blueprint of BUILTIN_BLUEPRINTS) store.saveBlueprint(blueprint)
  const workspace = store.createWorkspace({ name })
  const world = store.createWorld({ workspaceId: workspace.id, name: `${name}世界`, templateId: 'personal-world' })
  const blueprint = BUILTIN_BLUEPRINTS[0]!
  const employees = Array.from({ length: employeeCount }, (_, index) => store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: blueprint.id,
    blueprintVersion: blueprint.version,
    displayName: `${blueprint.displayName} ${index + 1}`,
  }))
  const session = createDirectSession(store, workspace.id, world.id, employees[0]!.id, name)
  const entry = enqueueStoredTurn(store, workspace.id, world.id, session.id, employees[0]!.id, `${name}长任务`)
  return { store, workspace, world, employees, entry }
}

function createDirectSession(store: SqliteStore, workspaceId: string, worldId: string, employeeId: string, title: string) {
  return store.createSession({
    workspaceId,
    worldId,
    kind: 'direct',
    title,
    participants: [{ participantId: 'owner', kind: 'owner' }, { participantId: employeeId, kind: 'employee' }],
  })
}

function enqueueStoredTurn(store: SqliteStore, workspaceId: string, worldId: string, sessionId: string, employeeId: string, content: string) {
  const turn = store.createWorkTurn({ workspaceId, worldId, sessionId, interactionKind: 'chat' })
  store.appendMessage({
    sessionId,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content,
    metadata: { workTurnId: turn.id, queueEmployeeId: employeeId },
    correlationId: sessionId,
  })
  return store.enqueueConversationTurn({
    workspaceId,
    worldId,
    sessionId,
    workTurnId: turn.id,
    employeeIds: [employeeId],
    conversationKind: 'direct',
  })
}

function scheduleInput(
  fixture: Awaited<ReturnType<typeof createScheduleFixture>>,
  employeeId: string,
  title: string,
) {
  return {
    worldId: fixture.world.id,
    employeeId,
    title,
    prompt: `执行${title}`,
    kind: 'once' as const,
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    permissionMode: 'workspace-write' as const,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for F09 dispatcher state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function trackedRunner(runner: (entry: ConversationQueueEntry) => Promise<void>) {
  return async (entry: ConversationQueueEntry): Promise<void> => {
    const execution = runner(entry)
    runnerSettlements.push(execution)
    return execution
  }
}
