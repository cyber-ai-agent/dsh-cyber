import { randomUUID } from 'node:crypto'

import type {
  AgentPermissionMode,
  ConversationQueueEntry,
  TaskSchedule,
  TaskScheduleKind,
  TaskScheduleRun,
  TaskScheduleStatus,
} from '@dsh-cyber/contracts'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { EmployeeActivityProjectionService } from './employee-activity-projection-service.js'
import type { CharacterSkillRuntime } from './character-skill-runtime.js'
import { factualRuntimeSource, type TurnAwareApprovalContinuationService } from './turn-aware-approval-continuation-service.js'
import type { WorldRuntimePromptComposer } from './world-runtime-context-composer.js'

interface ScheduleQueue {
  runEntryNow(queueEntryId: string, expectedRevision?: number): Promise<ConversationQueueEntry>
  reconcileWaiting(): Promise<number>
}

interface ScheduleContinuations {
  runQueuedDirect(workTurnId: string): Promise<unknown>
  setTurnSettledHandler?(handler: (workTurnId: string) => Promise<void>): void
}

export interface CreateTaskScheduleInput {
  worldId: string
  employeeId: string
  title: string
  prompt: string
  kind: TaskScheduleKind
  scheduledAt: string
  everySeconds?: number
  timeZone?: string
  permissionMode: Exclude<AgentPermissionMode, 'danger-full-access'>
}

export class TaskScheduleService {
  readonly #store: SqliteStore
  readonly #orchestrator: ConversationOrchestrator
  readonly #settings: Pick<WorldRuntimePromptComposer, 'composeRuntimePrompt'>
  readonly #employeeActivity: EmployeeActivityProjectionService
  readonly #skills: Pick<CharacterSkillRuntime, 'prepare'> | undefined
  readonly #continuations: ScheduleContinuations | undefined
  #queue: ScheduleQueue | undefined
  #timer: NodeJS.Timeout | undefined
  #running = false
  readonly #activeRuns = new Set<Promise<TaskScheduleRun>>()

  constructor(input: {
    store: SqliteStore
    orchestrator: ConversationOrchestrator
    settings: Pick<WorldRuntimePromptComposer, 'composeRuntimePrompt'>
    employeeActivity: EmployeeActivityProjectionService
    skills?: Pick<CharacterSkillRuntime, 'prepare'>
    continuations?: Pick<TurnAwareApprovalContinuationService, 'runQueuedDirect' | 'setTurnSettledHandler'>
    queue?: ScheduleQueue
  }) {
    this.#store = input.store
    this.#orchestrator = input.orchestrator
    this.#settings = input.settings
    this.#employeeActivity = input.employeeActivity
    this.#skills = input.skills
    this.#continuations = input.continuations
    this.#queue = input.queue
    this.#continuations?.setTurnSettledHandler?.(async (workTurnId) => { await this.reconcileWorkTurn(workTurnId) })
    this.#recoverInterruptedRuns()
  }

  /** Attach the shared durable queue after server composition has completed. */
  setQueue(queue: ScheduleQueue): void {
    this.#queue = queue
  }

  /** Reconcile a schedule-backed WorkTurn immediately after approval resume. */
  async reconcileWorkTurn(workTurnId: string): Promise<void> {
    const row = this.#store.database.prepare(
      "SELECT * FROM task_schedule_runs WHERE work_turn_id = ? AND status IN ('running', 'waiting-approval') ORDER BY started_at DESC LIMIT 1",
    ).get(workTurnId)
    if (row === undefined) return
    const run = mapRun(row)
    const scheduleRow = this.#store.database.prepare('SELECT * FROM task_schedules WHERE id = ?').get(run.scheduleId)
    if (scheduleRow === undefined) return
    const schedule = mapSchedule(scheduleRow)
    await this.#reconcileRunState(schedule, run.id, run.scheduledFor, false)
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => void this.runDue(), 5_000)
    this.#timer.unref()
    void this.runDue()
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await Promise.allSettled([...this.#activeRuns])
  }

  list(worldId: string): TaskSchedule[] {
    return this.#store.database.prepare(
      'SELECT * FROM task_schedules WHERE world_id = ? ORDER BY created_at DESC, id DESC',
    ).all(worldId).map(mapSchedule)
  }

  listRuns(scheduleId: string): TaskScheduleRun[] {
    return this.#store.database.prepare(
      'SELECT * FROM task_schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, id DESC LIMIT 50',
    ).all(scheduleId).map(mapRun)
  }

  create(input: CreateTaskScheduleInput): TaskSchedule {
    const world = this.#store.getWorld(input.worldId)
    const employee = this.#store.getEmployee(input.employeeId)
    if (world === undefined) throw new Error('世界不存在')
    if (world.status === 'archived') throw new Error(`世界「${world.name}」已归档，无法创建计划任务。请先恢复该世界。`)
    if (employee === undefined || employee.worldId !== world.id) throw new Error('所选角色不属于当前世界')
    const title = input.title.trim().slice(0, 120)
    const prompt = input.prompt.trim().slice(0, 8_000)
    if (!title || !prompt) throw new Error('计划名称和任务内容不能为空')
    const scheduledAt = validFutureOrRecentTime(input.scheduledAt)
    const everySeconds = input.kind === 'interval' ? input.everySeconds : undefined
    if (input.kind === 'interval' && (!Number.isInteger(everySeconds) || everySeconds! < 300)) {
      throw new Error('重复计划的间隔不能少于 5 分钟')
    }
    const now = new Date().toISOString()
    const schedule: TaskSchedule = {
      id: randomUUID(),
      workspaceId: world.workspaceId,
      worldId: world.id,
      employeeId: employee.id,
      title,
      prompt,
      kind: input.kind,
      scheduledAt,
      ...(everySeconds === undefined ? {} : { everySeconds }),
      timeZone: (input.timeZone ?? 'Asia/Shanghai').slice(0, 80),
      permissionMode: input.permissionMode,
      status: 'active',
      nextRunAt: scheduledAt,
      createdAt: now,
      updatedAt: now,
    }
    this.#store.database.prepare(
      `INSERT INTO task_schedules
       (id, workspace_id, world_id, employee_id, title, prompt, kind, scheduled_at,
        every_seconds, time_zone, permission_mode, status, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(schedule.id, schedule.workspaceId, schedule.worldId, schedule.employeeId, schedule.title, schedule.prompt,
      schedule.kind, schedule.scheduledAt, schedule.everySeconds ?? null, schedule.timeZone, schedule.permissionMode,
      schedule.status, schedule.nextRunAt!, schedule.createdAt, schedule.updatedAt)
    this.#appendEvent(schedule, 'schedule.created', { scheduleId: schedule.id, title: schedule.title, nextRunAt: schedule.nextRunAt! })
    return schedule
  }

  setStatus(worldId: string, scheduleId: string, status: Extract<TaskScheduleStatus, 'active' | 'paused'>): TaskSchedule {
    const schedule = this.#require(worldId, scheduleId)
    const now = new Date().toISOString()
    const nextRunAt = status === 'paused' ? undefined : nextOccurrence(schedule, now)
    this.#store.database.prepare(
      'UPDATE task_schedules SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    ).run(status, nextRunAt ?? null, now, schedule.id)
    const updated = this.#require(worldId, scheduleId)
    this.#appendEvent(updated, 'schedule.updated', { scheduleId, status, nextRunAt: nextRunAt ?? '' })
    return updated
  }

  delete(worldId: string, scheduleId: string): boolean {
    this.#require(worldId, scheduleId)
    return this.#store.database.prepare('DELETE FROM task_schedules WHERE id = ? AND world_id = ?').run(scheduleId, worldId).changes > 0
  }

  async runNow(worldId: string, scheduleId: string): Promise<TaskScheduleRun> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error('计划所属世界不存在')
    if (world.status === 'archived') throw new Error(`世界「${world.name}」已归档，计划任务不会运行。请先恢复该世界。`)
    await this.#reconcileRunningRuns()
    return this.#run(this.#require(worldId, scheduleId), new Date().toISOString(), true)
  }

  async runDue(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      await this.#reconcileRunningRuns()
      const now = new Date().toISOString()
      // An archived world is never driven by the scheduler. The join keeps
      // its schedules on the shelf instead of failing once per tick.
      const due = this.#store.database.prepare(
        `SELECT task_schedules.* FROM task_schedules
         JOIN worlds ON worlds.id = task_schedules.world_id
         WHERE task_schedules.status = 'active'
           AND worlds.status = 'active'
           AND task_schedules.next_run_at IS NOT NULL
           AND task_schedules.next_run_at <= ?
         ORDER BY task_schedules.next_run_at, task_schedules.id LIMIT 20`,
      ).all(now).map(mapSchedule)
      for (const schedule of due) await this.#run(schedule, schedule.nextRunAt!, false)
    } finally {
      this.#running = false
    }
  }

  #run(schedule: TaskSchedule, scheduledFor: string, manual: boolean): Promise<TaskScheduleRun> {
    const existing = this.#store.database.prepare(
      "SELECT * FROM task_schedule_runs WHERE schedule_id = ? AND status IN ('running', 'waiting-approval') ORDER BY started_at DESC LIMIT 1",
    ).get(schedule.id)
    if (existing !== undefined) return Promise.resolve(mapRun(existing))
    const execution = this.#execute(schedule, scheduledFor, manual)
    this.#activeRuns.add(execution)
    void execution.then(
      () => this.#activeRuns.delete(execution),
      () => this.#activeRuns.delete(execution),
    )
    return execution
  }

  async #execute(schedule: TaskSchedule, scheduledFor: string, manual: boolean): Promise<TaskScheduleRun> {
    const useQueue = this.#queue !== undefined && this.#continuations !== undefined
    const claim = this.#store.claimTaskScheduleRun({
      scheduleId: schedule.id,
      scheduledFor,
      workspaceId: schedule.workspaceId,
      worldId: schedule.worldId,
      employeeId: schedule.employeeId,
      title: schedule.title,
      prompt: schedule.prompt,
      permissionMode: schedule.permissionMode,
      ...(useQueue ? { queue: { id: scheduleQueueId(schedule.id, scheduledFor), queueMode: 'normal' as const } } : {}),
    })
    if (!claim.created) {
      // A crash can leave a terminal run committed before the schedule cursor
      // advances. Move that cursor once the same occurrence is observed again;
      // the existing run itself is never executed a second time.
      if (
        !manual &&
        schedule.nextRunAt === scheduledFor &&
        (claim.run.status === 'completed' || claim.run.status === 'failed' || claim.run.status === 'skipped')
      ) {
        this.#advance(schedule, scheduledFor, new Date().toISOString(), false)
      }
      return claim.run
    }
    const run = claim.run
    const workTurnId = run.workTurnId
    if (workTurnId === undefined) throw new Error('计划运行缺少 WorkTurn')
    try {
      this.#appendEvent(schedule, 'schedule.run.started', { scheduleId: schedule.id, runId: run.id, scheduledFor, manual })
      if (useQueue && claim.queueEntry !== undefined) {
        await this.#queue!.runEntryNow(claim.queueEntry.id, claim.queueEntry.revision)
        return this.#reconcileRunState(schedule, run.id, scheduledFor, manual)
      }
      return await this.#executeImmediate(schedule, run, scheduledFor, manual)
    } catch (cause) {
      const currentTurn = this.#store.getWorkTurn(workTurnId)
      // An approval pauses the existing turn. Keep the schedule occurrence
      // waiting and let the approval continuation resume this exact turn; a
      // later scheduler tick sees the existing run and cannot duplicate it.
      if (currentTurn?.status === 'waiting-approval') {
        this.#markRunWaiting(run.id)
        return this.listRuns(schedule.id).find((item) => item.id === run.id)!
      }
      if (currentTurn?.status === 'completed') return this.listRuns(schedule.id).find((item) => item.id === run.id)!
      const errorCode = scheduleError(cause)
      if (currentTurn !== undefined && (currentTurn.status === 'queued' || currentTurn.status === 'running')) {
        try { this.#store.interruptWorkTurn(workTurnId, errorCode) } catch { /* a recovery/controller race already settled it */ }
      }
      return this.#failRun(schedule, run.id, scheduledFor, manual, errorCode)
    }
  }

  async #executeImmediate(schedule: TaskSchedule, run: TaskScheduleRun, scheduledFor: string, manual: boolean): Promise<TaskScheduleRun> {
    const employee = this.#store.getEmployee(schedule.employeeId)
    if (employee === undefined || employee.status === 'archived') throw new Error('计划角色已不可用')
    if (run.workTurnId === undefined || run.sessionId === undefined) throw new Error('计划运行缺少会话事实')
    this.#store.startWorkTurn(run.workTurnId)
    const prepared = this.#skills === undefined
      ? undefined
      : await this.#skills.prepare({
          workspaceId: schedule.workspaceId,
          worldId: schedule.worldId,
          sessionId: run.sessionId,
          workTurnId: run.workTurnId,
          characterId: employee.id,
          prompt: schedule.prompt,
        })
    const actions = prepared?.actions ?? []
    if (actions.some((action) => action.status === 'waiting-for-approval')) {
      this.#store.waitWorkTurnForApproval(run.workTurnId)
      this.#markRunWaiting(run.id)
      return this.listRuns(schedule.id).find((item) => item.id === run.id)!
    }
    const result = await this.#orchestrator.continueDirect({
      workTurnId: run.workTurnId,
      employeeId: employee.id,
      runtimePrompt: await this.#settings.composeRuntimePrompt(schedule.worldId, employee, factualRuntimeSource(schedule.prompt, actions)),
      permissionMode: schedule.permissionMode,
    })
    // The concrete orchestrator settles the WorkTurn itself. Keep the seam
    // safe for a host runner that only returns a result after doing its work.
    if (this.#store.getWorkTurn(run.workTurnId)?.status === 'running') this.#store.completeWorkTurn(run.workTurnId)
    return this.#completeRun(schedule, run.id, scheduledFor, manual, result.session.id, result.replies[0]?.content)
  }

  async #reconcileRunningRuns(): Promise<void> {
    const rows = this.#store.database.prepare(
      "SELECT * FROM task_schedule_runs WHERE status IN ('running', 'waiting-approval') ORDER BY started_at, id",
    ).all().map(mapRun)
    for (const run of rows) {
      const scheduleRow = this.#store.database.prepare('SELECT * FROM task_schedules WHERE id = ?').get(run.scheduleId)
      if (scheduleRow === undefined) continue
      const schedule = mapSchedule(scheduleRow)
      await this.#reconcileRunState(schedule, run.id, run.scheduledFor, false)
    }
  }

  async #reconcileRunState(schedule: TaskSchedule, runId: string, scheduledFor: string, manual: boolean): Promise<TaskScheduleRun> {
    await this.#queue?.reconcileWaiting()
    const current = this.listRuns(schedule.id).find((item) => item.id === runId)
    if (current === undefined) throw new Error('计划运行不存在')
    if (current.status !== 'running' && current.status !== 'waiting-approval') return current
    const turn = current.workTurnId === undefined ? undefined : this.#store.getWorkTurn(current.workTurnId)
    if (turn?.status === 'waiting-approval') {
      this.#markRunWaiting(current.id)
      return this.listRuns(schedule.id).find((item) => item.id === runId)!
    }
    if (turn?.status === 'completed') {
      return this.#completeRun(schedule, current.id, scheduledFor, manual, current.sessionId, this.#summaryForRun(current))
    }
    if (turn?.status === 'failed' || turn?.status === 'interrupted') {
      return this.#failRun(schedule, current.id, scheduledFor, manual, turn.errorCode ?? 'turn-failed')
    }
    return current
  }

  #markRunWaiting(runId: string): void {
    this.#store.database.prepare(
      "UPDATE task_schedule_runs SET status = 'waiting-approval', completed_at = NULL, error_code = NULL WHERE id = ? AND status = 'running'",
    ).run(runId)
  }

  #completeRun(schedule: TaskSchedule, runId: string, scheduledFor: string, manual: boolean, sessionId: string | undefined, summary: string | undefined): TaskScheduleRun {
    const completedAt = new Date().toISOString()
    const normalizedSummary = summary?.trim().slice(0, 500) ?? ''
    const result = this.#store.database.prepare(
      `UPDATE task_schedule_runs
       SET status = 'completed', completed_at = ?, session_id = COALESCE(?, session_id), summary = ?, error_code = NULL
       WHERE id = ? AND status IN ('running', 'waiting-approval')`,
    ).run(completedAt, sessionId ?? null, normalizedSummary, runId)
    if (Number(result.changes) !== 1) return this.listRuns(schedule.id).find((item) => item.id === runId)!
    this.#advance(schedule, scheduledFor, completedAt, manual)
    this.#appendEvent(schedule, 'schedule.run.completed', { scheduleId: schedule.id, runId, sessionId: sessionId ?? '' })
    this.#employeeActivity.project(schedule.employeeId)
    return this.listRuns(schedule.id).find((item) => item.id === runId)!
  }

  #failRun(schedule: TaskSchedule, runId: string, scheduledFor: string, manual: boolean, errorCode: string): TaskScheduleRun {
    const completedAt = new Date().toISOString()
    const result = this.#store.database.prepare(
      `UPDATE task_schedule_runs
       SET status = 'failed', completed_at = ?, error_code = ?
       WHERE id = ? AND status IN ('running', 'waiting-approval')`,
    ).run(completedAt, errorCode, runId)
    if (Number(result.changes) !== 1) return this.listRuns(schedule.id).find((item) => item.id === runId)!
    this.#advance(schedule, scheduledFor, completedAt, manual)
    this.#appendEvent(schedule, 'schedule.run.failed', { scheduleId: schedule.id, runId, errorCode })
    return this.listRuns(schedule.id).find((item) => item.id === runId)!
  }

  #summaryForRun(run: TaskScheduleRun): string {
    if (run.sessionId === undefined) return ''
    const message = this.#store.listMessages(run.sessionId).findLast((item) =>
      item.kind === 'assistant' && (run.workTurnId === undefined || item.metadata.workTurnId === run.workTurnId))
    return message?.content ?? ''
  }

  #advance(schedule: TaskSchedule, scheduledFor: string, now: string, manual = false): void {
    if (manual && schedule.kind === 'interval') {
      this.#store.database.prepare(
        'UPDATE task_schedules SET last_run_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, schedule.id)
      return
    }
    const nextRunAt = schedule.kind === 'interval' ? intervalAfter(scheduledFor, schedule.everySeconds!, now) : undefined
    const status: TaskScheduleStatus = nextRunAt === undefined ? 'completed' : 'active'
    this.#store.database.prepare(
      'UPDATE task_schedules SET status = ?, next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?',
    ).run(status, nextRunAt ?? null, now, now, schedule.id)
  }

  #recoverInterruptedRuns(): void {
    const now = new Date().toISOString()
    const interrupted = this.#store.database.prepare(
      "SELECT * FROM task_schedule_runs WHERE status IN ('running', 'waiting-approval') ORDER BY started_at, id",
    ).all().map(mapRun)
    for (const run of interrupted) {
      const scheduleRow = this.#store.database.prepare('SELECT * FROM task_schedules WHERE id = ?').get(run.scheduleId)
      if (scheduleRow === undefined) continue
      const schedule = mapSchedule(scheduleRow)
      const workTurn = run.workTurnId === undefined ? undefined : this.#store.getWorkTurn(run.workTurnId)
      const queueEntry = run.workTurnId === undefined || workTurn === undefined
        ? undefined
        : this.#store.getConversationQueueEntryByWorkTurn(workTurn.worldId, run.workTurnId)

      // An approval pause is a durable, recoverable state. Keep both the run
      // and its WorkTurn; repair only the queue projection if the process died
      // between the two state transitions.
      if (workTurn?.status === 'waiting-approval') {
        if (queueEntry?.status === 'running') {
          try {
            this.#store.waitConversationQueueEntryForApproval({ queueEntryId: queueEntry.id, expectedRevision: queueEntry.revision })
          } catch { /* another recovery path won */ }
        }
        this.#markRunWaiting(run.id)
        continue
      }

      // A queued schedule has not entered an AgentRun and can safely remain in
      // the shared queue for the next dispatcher process.
      if (workTurn?.status === 'queued' && queueEntry?.status === 'queued') {
        if (run.status === 'waiting-approval') {
          this.#store.database.prepare(
            "UPDATE task_schedule_runs SET status = 'running' WHERE id = ? AND status = 'waiting-approval'",
          ).run(run.id)
        }
        continue
      }

      if (workTurn?.status === 'completed') {
        this.#completeRunSync(schedule, run, now)
        continue
      }
      if (workTurn?.status === 'failed' || workTurn?.status === 'interrupted') {
        this.#failRunSync(schedule, run, now, workTurn.errorCode ?? 'service-restarted')
        continue
      }

      if (workTurn !== undefined && ['queued', 'running'].includes(workTurn.status)) {
        try { this.#store.interruptWorkTurn(workTurn.id, 'service-restarted') } catch { /* another recovery path won */ }
      }
      this.#failRunSync(schedule, run, now, 'service-restarted')
    }
  }

  #completeRunSync(schedule: TaskSchedule, run: TaskScheduleRun, completedAt: string): void {
    const result = this.#store.database.prepare(
      `UPDATE task_schedule_runs
       SET status = 'completed', completed_at = ?, summary = ?, error_code = NULL
       WHERE id = ? AND status IN ('running', 'waiting-approval')`,
    ).run(completedAt, this.#summaryForRun(run).trim().slice(0, 500), run.id)
    if (Number(result.changes) !== 1) return
    this.#advance(schedule, run.scheduledFor, completedAt, false)
  }

  #failRunSync(schedule: TaskSchedule, run: TaskScheduleRun, completedAt: string, errorCode: string): void {
    const result = this.#store.database.prepare(
      `UPDATE task_schedule_runs SET status = 'failed', completed_at = ?, error_code = ?
       WHERE id = ? AND status IN ('running', 'waiting-approval')`,
    ).run(completedAt, errorCode, run.id)
    if (Number(result.changes) !== 1) return
    this.#advance(schedule, run.scheduledFor, completedAt, false)
  }

  #require(worldId: string, scheduleId: string): TaskSchedule {
    const row = this.#store.database.prepare('SELECT * FROM task_schedules WHERE id = ? AND world_id = ?').get(scheduleId, worldId)
    if (row === undefined) throw new Error('计划不存在')
    return mapSchedule(row)
  }

  #appendEvent(schedule: TaskSchedule, type: 'schedule.created' | 'schedule.updated' | 'schedule.run.started' | 'schedule.run.completed' | 'schedule.run.failed', payload: Record<string, string | boolean>): void {
    this.#store.appendDomainEvent({ workspaceId: schedule.workspaceId, worldId: schedule.worldId, type, actorId: 'owner', actorKind: 'owner', correlationId: schedule.id, payload })
  }
}

function mapSchedule(row: Record<string, unknown>): TaskSchedule {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), worldId: String(row.world_id), employeeId: String(row.employee_id),
    title: String(row.title), prompt: String(row.prompt), kind: row.kind as TaskScheduleKind, scheduledAt: String(row.scheduled_at),
    ...(row.every_seconds === null ? {} : { everySeconds: Number(row.every_seconds) }), timeZone: String(row.time_zone),
    permissionMode: row.permission_mode as TaskSchedule['permissionMode'], status: row.status as TaskScheduleStatus,
    ...(row.next_run_at === null ? {} : { nextRunAt: String(row.next_run_at) }),
    ...(row.last_run_at === null ? {} : { lastRunAt: String(row.last_run_at) }),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapRun(row: Record<string, unknown>): TaskScheduleRun {
  return {
    id: String(row.id), scheduleId: String(row.schedule_id), workspaceId: String(row.workspace_id), worldId: String(row.world_id),
    employeeId: String(row.employee_id), status: row.status as TaskScheduleRun['status'], scheduledFor: String(row.scheduled_for), startedAt: String(row.started_at),
    ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
    ...(row.session_id === null ? {} : { sessionId: String(row.session_id) }),
    ...(typeof row.work_turn_id === 'string' ? { workTurnId: row.work_turn_id } : {}),
    ...(row.summary === null ? {} : { summary: String(row.summary) }),
    ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
  }
}

function validFutureOrRecentTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) throw new Error('执行时间无效')
  if (date.valueOf() < Date.now() - 60_000) throw new Error('执行时间不能早于当前时间')
  return date.toISOString()
}

function intervalAfter(scheduledFor: string, everySeconds: number, now: string): string {
  let next = new Date(scheduledFor).valueOf() + everySeconds * 1_000
  const current = new Date(now).valueOf()
  while (next <= current) next += everySeconds * 1_000
  return new Date(next).toISOString()
}

function nextOccurrence(schedule: TaskSchedule, now: string): string | undefined {
  if (schedule.kind === 'once') return new Date(schedule.scheduledAt).valueOf() > Date.now() ? schedule.scheduledAt : now
  return intervalAfter(schedule.lastRunAt ?? schedule.scheduledAt, schedule.everySeconds!, now)
}

function scheduleQueueId(scheduleId: string, scheduledFor: string): string {
  return `schedule:${scheduleId}:${scheduledFor}:queue`
}

function scheduleError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.toLowerCase() : ''
  if (message.includes('model') || message.includes('credential')) return 'model-unavailable'
  if (message.includes('runtime')) return 'runtime-unavailable'
  if (message.includes('角色')) return 'employee-unavailable'
  return 'execution-failed'
}
