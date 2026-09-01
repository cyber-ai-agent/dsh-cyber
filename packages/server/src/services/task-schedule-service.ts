import { randomUUID } from 'node:crypto'

import type {
  AgentPermissionMode,
  TaskSchedule,
  TaskScheduleKind,
  TaskScheduleRun,
  TaskScheduleStatus,
} from '@dsh-cyber/contracts'
import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { EmployeeActivityProjectionService } from './employee-activity-projection-service.js'
import type { WorldRuntimePromptComposer } from './world-runtime-context-composer.js'

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
  #timer: NodeJS.Timeout | undefined
  #running = false
  readonly #activeRuns = new Set<Promise<TaskScheduleRun>>()

  constructor(input: { store: SqliteStore; orchestrator: ConversationOrchestrator; settings: Pick<WorldRuntimePromptComposer, 'composeRuntimePrompt'>; employeeActivity: EmployeeActivityProjectionService }) {
    this.#store = input.store
    this.#orchestrator = input.orchestrator
    this.#settings = input.settings
    this.#employeeActivity = input.employeeActivity
    this.#recoverInterruptedRuns()
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
    return this.#run(this.#require(worldId, scheduleId), new Date().toISOString(), true)
  }

  async runDue(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
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
      "SELECT * FROM task_schedule_runs WHERE schedule_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
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
    const startedAt = new Date().toISOString()
    const run: TaskScheduleRun = {
      id: randomUUID(), scheduleId: schedule.id, workspaceId: schedule.workspaceId, worldId: schedule.worldId,
      employeeId: schedule.employeeId, status: 'running', scheduledFor, startedAt,
    }
    try {
      this.#store.database.prepare(
        `INSERT INTO task_schedule_runs
         (id, schedule_id, workspace_id, world_id, employee_id, status, scheduled_for, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(run.id, run.scheduleId, run.workspaceId, run.worldId, run.employeeId, run.scheduledFor, run.startedAt)
    } catch {
      const existing = this.#store.database.prepare(
        'SELECT * FROM task_schedule_runs WHERE schedule_id = ? AND scheduled_for = ?',
      ).get(schedule.id, scheduledFor)
      if (existing !== undefined) return mapRun(existing)
      throw new Error('计划运行记录创建失败')
    }
    this.#appendEvent(schedule, 'schedule.run.started', { scheduleId: schedule.id, runId: run.id, scheduledFor, manual })
    try {
      const employee = this.#store.getEmployee(schedule.employeeId)
      if (employee === undefined || employee.status === 'archived') throw new Error('计划角色已不可用')
      const result = await this.#orchestrator.direct({
        workspaceId: schedule.workspaceId,
        worldId: schedule.worldId,
        employeeId: schedule.employeeId,
        title: `计划 · ${schedule.title}`,
        prompt: schedule.prompt,
        metadata: { interactionKind: 'task', scheduleId: schedule.id, scheduleRunId: run.id, scheduledFor },
        runtimePrompt: await this.#settings.composeRuntimePrompt(schedule.worldId, employee, schedule.prompt),
        permissionMode: schedule.permissionMode,
      })
      const completedAt = new Date().toISOString()
      const summary = result.replies[0]?.content.trim().slice(0, 500) ?? ''
      this.#store.database.prepare(
        `UPDATE task_schedule_runs SET status = 'completed', completed_at = ?, session_id = ?, summary = ? WHERE id = ?`,
      ).run(completedAt, result.session.id, summary, run.id)
      this.#advance(schedule, scheduledFor, completedAt, manual)
      this.#appendEvent(schedule, 'schedule.run.completed', { scheduleId: schedule.id, runId: run.id, sessionId: result.session.id })
      this.#employeeActivity.project(schedule.employeeId)
      return this.listRuns(schedule.id).find((item) => item.id === run.id)!
    } catch (cause) {
      const completedAt = new Date().toISOString()
      const errorCode = scheduleError(cause)
      this.#store.database.prepare(
        `UPDATE task_schedule_runs SET status = 'failed', completed_at = ?, error_code = ? WHERE id = ?`,
      ).run(completedAt, errorCode, run.id)
      this.#advance(schedule, scheduledFor, completedAt, manual)
      this.#appendEvent(schedule, 'schedule.run.failed', { scheduleId: schedule.id, runId: run.id, errorCode })
      return this.listRuns(schedule.id).find((item) => item.id === run.id)!
    }
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
      `SELECT runs.scheduled_for, schedules.*
       FROM task_schedule_runs AS runs JOIN task_schedules AS schedules ON schedules.id = runs.schedule_id
       WHERE runs.status = 'running'`,
    ).all() as Array<Record<string, unknown> & { scheduled_for: unknown }>
    for (const row of interrupted) this.#advance(mapSchedule(row), String(row.scheduled_for), now)
    this.#store.database.prepare(
      `UPDATE task_schedule_runs SET status = 'failed', completed_at = ?, error_code = 'service-restarted'
       WHERE status = 'running'`,
    ).run(now)
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

function scheduleError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.toLowerCase() : ''
  if (message.includes('model') || message.includes('credential')) return 'model-unavailable'
  if (message.includes('runtime')) return 'runtime-unavailable'
  if (message.includes('角色')) return 'employee-unavailable'
  return 'execution-failed'
}
