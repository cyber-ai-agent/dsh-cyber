import { createHash } from 'node:crypto'

import { parseCreateWorkTask, type Deliverable, type Review, type WorkTask, type WorkTaskDetail, type WorkTaskFromSource, type WorkTaskPriority, type WorkTaskStatus, type WorkTurnStatus } from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import { SqliteUnitOfWork, WorkSystemRepository, projectSourceTasks, sourceTaskResults, type SqliteStore } from '@dsh-cyber/persistence'

import type { GroupTaskCollaborationService, GroupTaskRunResult } from './group-task-collaboration-service.js'
import type { GroupTaskRoutingResult } from './group-task-router.js'
import type { CharacterSkillRuntime } from './character-skill-runtime.js'
import { factualRuntimeSource } from './turn-aware-approval-continuation-service.js'
import { ServiceError } from './service-error.js'

/**
 * States the owner may start an execution from. `failed` is included so a
 * task that lost its turn (model refusal, rejected review, restart) can be
 * retried. Plans, runs, deliverables and reviews of earlier attempts stay as
 * history and the next attempt number continues from them.
 */
const EXECUTABLE_STATUSES: readonly WorkTaskStatus[] = ['draft', 'changes-requested', 'failed']

/**
 * Source-turn states that mean the work is still in someone else's hands.
 *
 * `waiting-approval` counts: the turn is paused on a decision and will carry on
 * afterwards, so the work it was asked for has not finished either.
 */
const UNSETTLED_SOURCE_TURN: readonly WorkTurnStatus[] = ['queued', 'running', 'waiting-approval']

/** What the task list asks for: the default view, one status, or everything. */
export type WorkTaskListScope = WorkTaskStatus | 'all'

/**
 * The statuses a task can be cancelled from.
 *
 * Every one of them is a task that will not reach a useful end on its own:
 * nothing is executing, and the owner is the only thing that would move it.
 * `running` and `waiting-approval` are deliberately absent — an execution owns
 * that row and settles it itself, so cancelling underneath it would race a turn
 * still in flight. So is `waiting-review`, which already has a deliverable and
 * is ended by a review decision, and `completed`, which is history.
 */
const CANCELLABLE: readonly WorkTaskStatus[] = ['draft', 'planning', 'ready', 'changes-requested', 'failed', 'recovery-required']

export class WorkSystemService {
  readonly #store: SqliteStore
  readonly #repository: WorkSystemRepository
  readonly #uow: SqliteUnitOfWork
  readonly #groupTasks: GroupTaskCollaborationService
  readonly #skillRuntime: Pick<CharacterSkillRuntime, 'prepare'> | undefined

  constructor(options: { store: SqliteStore; groupTasks: GroupTaskCollaborationService; skillRuntime?: Pick<CharacterSkillRuntime, 'prepare'> }) {
    this.#store = options.store
    this.#repository = new WorkSystemRepository(options.store.database)
    this.#uow = new SqliteUnitOfWork(options.store.database)
    this.#groupTasks = options.groupTasks
    this.#skillRuntime = options.skillRuntime
  }

  create(input: { workspaceId: string; worldId: string; title: string; description: string; priority: WorkTaskPriority; dueAt?: string; coordinatorEmployeeId?: string }): WorkTask {
    const world = this.#store.getWorld(input.worldId)
    if (world === undefined || world.workspaceId !== input.workspaceId || world.status === 'archived') throw new Error('任务世界不可用')
    if (input.coordinatorEmployeeId !== undefined) this.#requireEmployee(input.worldId, input.coordinatorEmployeeId)
    return this.#repository.createTask({ ...input, createdBy: 'owner' })
  }

  /**
   * The task a conversation turn asked for.
   *
   * Created on the first call; found again when the same turn comes back
   * through a resend, the recovery pass after a restart or a retry — never a
   * second task for one turn, and never an error the UI cannot act on: the
   * later caller gets the earlier caller's task with `created: false`. This
   * only records the task. Execution stays with the queue and the Run that
   * already own the turn.
   */
  createFromSource(input: { worldId: string; workTurnId: string; title: string; description: string; priority?: WorkTaskPriority; dueAt?: string; coordinatorEmployeeId?: string }): WorkTaskFromSource {
    const world = this.#store.getWorld(input.worldId)
    if (world === undefined || world.status === 'archived') throw new Error('任务世界不可用')
    const turn = this.#store.getWorkTurn(input.workTurnId)
    if (turn === undefined) throw new Error('来源回合不存在')
    if (turn.workspaceId !== world.workspaceId || turn.worldId !== world.id) throw new Error('来源回合不属于当前世界')
    const draft = parseCreateWorkTask({
      title: input.title,
      description: input.description,
      priority: input.priority,
      dueAt: input.dueAt,
      coordinatorEmployeeId: input.coordinatorEmployeeId,
    })
    if (draft.coordinatorEmployeeId !== undefined) this.#requireEmployee(world.id, draft.coordinatorEmployeeId)
    const result = this.#uow.run(() => this.#repository.createTaskFromSource({
      ...draft, workspaceId: world.workspaceId, worldId: world.id, workTurnId: turn.id, createdBy: 'owner',
    }))
    return { ...result, task: projectSourceTasks(this.#store.database, [result.task])[0]! }
  }

  /**
   * The world's tasks, with cancelled ones out of the default view.
   *
   * A cancelled task is kept, not deleted, so it has to stay reachable: asking
   * for `cancelled` or for `all` shows it again. This is the same shape the
   * world list uses for archived worlds — a deliberate second view, never mixed
   * into the main one.
   */
  list(worldId: string, scope?: WorkTaskListScope): WorkTask[] {
    const tasks = projectSourceTasks(this.#store.database, this.#repository.listTasks(worldId))
    if (scope === 'all') return tasks
    return tasks.filter((task) => scope === undefined ? task.status !== 'cancelled' : task.status === scope)
  }

  /**
   * The owner's way out of a task that should not have been created.
   *
   * Cancel, not delete: the row keeps its plans, runs, deliverables and reviews
   * and stays readable by id. It only leaves the default list. A task an
   * execution is holding refuses instead of racing it, and so does one that
   * another action already settled — including a second cancel, which is a
   * refusal rather than a quiet success, because it means the caller was
   * looking at a stale view.
   */
  cancel(taskId: string): WorkTaskDetail {
    const task = this.#repository.requireTask(taskId)
    const source = task.sourceWorkTurnId === undefined ? undefined : this.#store.getWorkTurn(task.sourceWorkTurnId)
    if (source !== undefined && UNSETTLED_SOURCE_TURN.includes(source.status)) {
      throw new ServiceError('conflict', 'work_task_source_turn_unsettled', '来源对话仍在执行，请先停止对话或等待它结束。')
    }
    if (!CANCELLABLE.includes(task.status)) throw new ServiceError('conflict', 'work_task_not_cancellable', cancelRefusal(task.status))
    return this.#uow.run(() => {
      this.#repository.transitionTask(task.id, [task.status], 'cancelled')
      return this.#repository.detail(task.id)
    })
  }

  taskForSourceTurn(workTurnId: string): WorkTask | undefined {
    const task = this.#repository.getTaskBySourceWorkTurn(workTurnId)
    return task === undefined ? undefined : projectSourceTasks(this.#store.database, [task])[0]
  }
  detail(taskId: string): WorkTaskDetail {
    const detail = this.#repository.detail(taskId)
    return {
      ...detail, task: projectSourceTasks(this.#store.database, [detail.task])[0]!,
      ...(detail.sourceTurn === undefined ? {} : { sourceTurn: {
        ...detail.sourceTurn, results: sourceTaskResults(this.#store.database, detail.task, detail.sourceTurn),
      } }),
    }
  }

  /** Explicit owner acceptance of the existing source result, not another run.
   * The transaction rechecks ownership and the live source before changing the
   * row. Interrupted/failed sources require the owner's explanation; their
   * actual run status and errors remain intact for audit.
   */
  completeFromSource(taskId: string, input: { sourceWorkTurnId: string; confirmed: boolean; note?: string }): WorkTaskDetail {
    if (input.confirmed !== true) throw new ServiceError('invalid', 'work_task_confirmation_required', '请明确确认任务已经完成。')
    const note = input.note?.trim() ?? ''
    if (note.length > 2000) throw new ServiceError('invalid', 'work_task_completion_note_invalid', '完成说明不能超过 2000 字。')
    return this.#uow.run(() => {
      const detail = this.#repository.detail(taskId)
      const { task, sourceTurn } = detail
      if (task.sourceWorkTurnId !== input.sourceWorkTurnId || task.currentPlanRevision !== 0 || detail.runs.length > 0 || detail.plans.length > 0) {
        throw new ServiceError('conflict', 'work_task_source_completion_unavailable', '任务已变化，或已有独立执行，请刷新后按当前交付验收。')
      }
      if (task.status === 'completed') return this.detail(taskId)
      if (task.status !== 'draft' || sourceTurn === undefined || UNSETTLED_SOURCE_TURN.includes(sourceTurn.status)
        || sourceTurn.runs.some((run) => ['queued', 'running', 'waiting-approval'].includes(run.status))) {
        throw new ServiceError('conflict', 'work_task_source_turn_unsettled', '当前任务不能确认完成；来源对话须先结束，已取消任务不能修改。')
      }
      if (sourceTurn.status !== 'completed' && !note) throw new ServiceError('invalid', 'work_task_completion_note_required', '来源对话未正常结束，请说明你已核对的完成结果。')
      this.#repository.confirmSourceCompletion(task, sourceTurn, note)
      return this.detail(taskId)
    })
  }
  currentWork(employeeId: string): WorkTaskDetail[] { return this.#repository.currentWork(employeeId) }
  taskForDeliverable(deliverableId: string): WorkTask | undefined { return this.#repository.taskForDeliverable(deliverableId) }

  async execute(taskId: string, input: {
    employeeIds: string[]
    coordinatorEmployeeId?: string
    /** Stable retry key. `submissionKey` and `clientTurnId` are aliases. */
    idempotencyKey?: string
    submissionKey?: string
    clientTurnId?: string
  }): Promise<WorkTaskDetail> {
    let task = this.#repository.requireTask(taskId)
    const world = this.#store.getWorld(task.worldId)
    if (world === undefined) throw new Error('任务世界不可用')
    if (world.status === 'archived') throw new Error(`世界「${world.name}」已归档，无法执行任务。请先恢复该世界。`)
    const idempotencyKey = resolveExecutionKey(input)
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 1) throw new Error('任务至少需要一名角色')
    const coordinatorEmployeeId = input.coordinatorEmployeeId ?? (employeeIds.length === 1 ? employeeIds[0]! : task.coordinatorEmployeeId ?? employeeIds[0]!)
    const previousFeedback = this.#repository.detail(task.id).reviews.filter((review) => review.decision === 'request-changes').at(-1)?.feedback
    const prompt = previousFeedback === undefined
      ? `${task.title}\n\n${task.description}`
      : `${task.title}\n\n${task.description}\n\n[上一版验收反馈]\n${previousFeedback}\n请生成新版本，不要覆盖旧交付。`
    const fingerprintSha256 = idempotencyKey === undefined ? undefined : executionFingerprint({
      taskId: task.id,
      employeeIds,
      coordinatorEmployeeId,
      prompt,
    })
    // Read the durable claim before re-validating the mutable roster. A safe
    // replay must not call routing, authorization or runtime code again after
    // the original submission has already been accepted.
    if (idempotencyKey !== undefined) {
      const existing = this.#repository.getTaskRunByIdempotency(task.id, idempotencyKey)
      if (existing !== undefined) {
        if (existing.fingerprintSha256 !== fingerprintSha256) throw new ServiceError('conflict', 'task_execution_conflict', '相同执行提交键已对应另一条请求，不能复用')
        return this.#repository.detail(task.id)
      }
    }
    if (!employeeIds.includes(coordinatorEmployeeId)) throw new Error('协调角色必须属于任务成员')
    for (const employeeId of employeeIds) this.#requireEmployee(task.worldId, employeeId)
    // A sole assignee coordinates their own task. The coordinator chosen at
    // creation only binds while the roster can still contain them.
    if (!EXECUTABLE_STATUSES.includes(task.status)) {
      throw new ServiceError('conflict', 'work_task_not_executable', `任务当前处于「${task.status}」状态，不能再次执行`)
    }
    // The conversation turn that proposed this task may still be doing the work.
    // Running the task now would repeat it concurrently, with whatever real
    // side effects it has — so this is a boundary, not a warning: the owner may
    // repeat the work once the turn that asked for it has settled, and the
    // settled turn's outcome is on the task for them to read first.
    if (task.sourceWorkTurnId !== undefined) {
      const sourceTurn = this.#store.getWorkTurn(task.sourceWorkTurnId)
      if (sourceTurn !== undefined && UNSETTLED_SOURCE_TURN.includes(sourceTurn.status)) {
        throw new ServiceError('conflict', 'work_task_source_turn_unsettled', `提出该任务的对话仍在进行（${sourceTurn.status}），等它结束后再执行，以免重复产生一次真实副作用`)
      }
    }
    // Routing is read-only. It must complete before the atomic reservation so
    // an empty route cannot leave a TaskRun without an executable WorkTurn.
    const routing = await this.#groupTasks.plan({
      workspaceId: task.workspaceId,
      worldId: task.worldId,
      employeeIds,
      prompt,
      coordinatorEmployeeId,
    })
    if (routing.steps.length === 0 || routing.coordinatorEmployeeId === '') {
      throw new Error('Task Router could not select an executor')
    }
    let reservation
    try {
      reservation = this.#repository.beginExecution({
        taskId: task.id,
        workspaceId: task.workspaceId,
        worldId: task.worldId,
        employeeIds,
        coordinatorEmployeeId: routing.coordinatorEmployeeId,
        prompt,
        title: task.title,
        steps: routing.steps,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(fingerprintSha256 === undefined ? {} : { fingerprintSha256 }),
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('different fingerprint')) {
        throw new ServiceError('conflict', 'task_execution_conflict', '相同执行提交键已对应另一条请求，不能复用')
      }
      throw error
    }
    if (!reservation.created) return this.#repository.detail(task.id)
    const started = Date.now()
    try {
      this.#store.startWorkTurn(reservation.workTurn.id)
      const actions = await this.#prepareSkillAction(reservation.workTurn.id, reservation.session.id, prompt, routing)
      if (actions.some((action) => action.status === 'waiting-for-approval')) {
        return this.#repository.waitExecutionForApproval(reservation.taskRun.id)
      }
      return (await this.#runClaimedExecution(reservation.taskRun.id, routing, actions, started)).detail
    } catch (error) {
      try {
        this.#repository.failExecution({
          taskRunId: reservation.taskRun.id,
          errorCode: executionErrorCode(error),
          agentRunIds: this.#store.listTurnAgentRuns(reservation.workTurn.id).map((run) => run.id),
        })
      } catch {
        // Preserve the original runtime error. Startup recovery can settle a
        // reservation if this process dies while recording the failure.
      }
      throw error
    }
  }

  /** Continue an approved/rejected Task Center action without planning or preparing it again. */
  async continueAfterApproval(workTurnId: string, actions: CharacterSkillAction[]): Promise<GroupTaskRunResult> {
    const run = this.#repository.getTaskRunByWorkTurn(workTurnId)
    if (run === undefined || run.status !== 'waiting-approval') throw new Error('Task approval continuation is unavailable')
    const detail = this.#repository.detail(run.taskId)
    const routing = routingFromTaskDetail(detail, run.planRevisionId)
    this.#repository.resumeExecutionAfterApproval(run.id)
    try {
      return (await this.#runClaimedExecution(run.id, routing, actions, Date.now())).result
    } catch (error) {
      try {
        this.#repository.failExecution({
          taskRunId: run.id,
          errorCode: executionErrorCode(error),
          agentRunIds: this.#store.listTurnAgentRuns(workTurnId).map((agentRun) => agentRun.id),
        })
      } catch {
        // Keep the continuation failure; startup recovery owns any residue.
      }
      throw error
    }
  }

  async #prepareSkillAction(workTurnId: string, sessionId: string, prompt: string, routing: GroupTaskRoutingResult): Promise<CharacterSkillAction[]> {
    if (this.#skillRuntime === undefined) return []
    const turn = this.#store.getWorkTurn(workTurnId)
    if (turn === undefined) throw new Error('Task execution WorkTurn is unavailable')
    const actionEmployees = [...new Set(routing.steps.flatMap((step) => step.assignedEmployeeIds))]
    for (const characterId of actionEmployees) {
      const prepared = await this.#skillRuntime.prepare({
        workspaceId: turn.workspaceId,
        worldId: turn.worldId,
        sessionId,
        workTurnId,
        characterId,
        prompt,
        maxActions: 1,
      })
      if (prepared.actions.length > 0) return [prepared.actions[0]!]
    }
    return []
  }

  async #runClaimedExecution(taskRunId: string, routing: GroupTaskRoutingResult, actions: CharacterSkillAction[], started: number): Promise<{ detail: WorkTaskDetail; result: GroupTaskRunResult }> {
    const execution = this.#repository.getTaskExecution(taskRunId)
    const task = this.#repository.requireTask(execution.taskRun.taskId)
    const employeeIds = this.#store.listParticipants(execution.session.id)
      .filter((participant) => participant.kind === 'employee')
      .map((participant) => participant.participantId)
    const result = await this.#groupTasks.run({
      workspaceId: task.workspaceId,
      worldId: task.worldId,
      employeeIds,
      coordinatorEmployeeId: routing.coordinatorEmployeeId,
      prompt: execution.ownerMessage.content,
      transformedPrompt: factualRuntimeSource(execution.ownerMessage.content, actions),
      title: task.title,
      sessionId: execution.session.id,
      existingWorkTurnId: execution.workTurn.id,
      metadata: execution.ownerMessage.metadata,
      preplannedRouting: routing,
    })
    const agentRuns = this.#store.listTurnAgentRuns(result.workTurnId)
    const detail = this.#repository.completeExecution({
      taskRunId,
      plan: result.plan,
      agentRuns,
      coordinatorEmployeeId: routing.coordinatorEmployeeId,
      latency: Date.now() - started,
    })
    return { detail, result }
  }

  submitDeliverable(input: { taskId: string; taskRunId: string; submittedByEmployeeId: string; artifactId: string; artifactVersionId: number; title: string; summary: string; evidenceRefs?: string[] }): Deliverable {
    const task = this.#repository.requireTask(input.taskId)
    this.#requireEmployee(task.worldId, input.submittedByEmployeeId)
    return this.#uow.run(() => this.#repository.createDeliverable({ ...input, evidenceRefs: input.evidenceRefs ?? [] }))
  }

  review(deliverableId: string, input: { decision: Review['decision']; feedback: string }): WorkTaskDetail {
    return this.#uow.run(() => this.#repository.review({ deliverableId, decision: input.decision, feedback: input.feedback, reviewerId: 'owner' }))
  }

  /**
   * A task is `running` only while this process awaits its turn. After a
   * restart nothing awaits it any more and the store has already marked the
   * turn `interrupted` / `service-restarted`; the task follows into `failed`
   * so the owner sees a status that is true and can retry the same task.
   * Nothing is re-executed here.
   */
  recoverAfterRestart(): { failed: number } {
    let failed = this.#repository.recoverExecutionsAfterRestart().recovered
    for (const workspace of this.#store.listWorkspaces()) {
      for (const world of this.#store.listWorlds(workspace.id, true)) {
        for (const task of this.#repository.listTasks(world.id, 'running')) {
          this.#uow.run(() => this.#repository.markExecutionFailed(task.id))
          failed += 1
        }
      }
    }
    return { failed }
  }

  #requireEmployee(worldId: string, employeeId: string): void {
    const employee = this.#store.getEmployee(employeeId)
    if (employee === undefined || employee.worldId !== worldId || employee.status === 'archived') throw new Error(`任务角色不可用：${employeeId}`)
  }
}

function resolveExecutionKey(input: { idempotencyKey?: string; submissionKey?: string; clientTurnId?: string }): string | undefined {
  const supplied = [input.idempotencyKey, input.submissionKey, input.clientTurnId]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim())
    .filter(Boolean)
  if (supplied.length === 0) return undefined
  const key = supplied[0]!
  if (supplied.some((candidate) => candidate !== key)) throw new ServiceError('invalid', 'task_execution_key_conflict', '执行提交键参数不一致')
  if (key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) throw new ServiceError('invalid', 'task_execution_key_invalid', '执行提交键无效')
  return key
}

function executionFingerprint(input: { taskId: string; employeeIds: string[]; coordinatorEmployeeId: string; prompt: string }): string {
  return createHash('sha256').update(JSON.stringify({
    taskId: input.taskId,
    employeeIds: input.employeeIds,
    coordinatorEmployeeId: input.coordinatorEmployeeId,
    prompt: input.prompt,
  })).digest('hex')
}

function executionErrorCode(error: unknown): string {
  if (error instanceof ServiceError) return error.code
  if (error !== null && typeof error === 'object') {
    const failureKind = (error as { failureKind?: unknown }).failureKind
    if (typeof failureKind === 'string' && /^[a-z-]+$/.test(failureKind)) return `runtime-${failureKind}`
  }
  return 'task-execution-failed'
}

function routingFromTaskDetail(detail: WorkTaskDetail, planRevisionId: string): GroupTaskRoutingResult {
  const plan = detail.plans.find((candidate) => candidate.id === planRevisionId)
  if (plan === undefined) throw new Error('Task execution plan is unavailable')
  const steps = detail.steps
    .filter((step) => step.planRevisionId === plan.id)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((step) => ({
      id: step.id,
      ordinal: step.ordinal,
      requiredSkills: [...step.requiredSkills],
      assignedEmployeeIds: [...step.assignedEmployeeIds],
      dependsOn: [...step.dependsOn],
      executionMode: step.executionMode,
      status: 'pending' as const,
    }))
  if (steps.length === 0 || detail.task.coordinatorEmployeeId === undefined) throw new Error('Task execution routing is unavailable')
  return {
    coordinatorEmployeeId: detail.task.coordinatorEmployeeId,
    requiredSkillIds: [...new Set(steps.flatMap((step) => step.requiredSkills))],
    steps,
  }
}

function cancelRefusal(status: WorkTaskStatus): string {
  switch (status) {
    case 'running':
    case 'waiting-approval':
      return '任务正在执行，无法取消。等这次执行结束后再处理。'
    case 'waiting-review':
      return '任务已经产出交付，请用验收结束它，而不是取消。'
    case 'completed':
      return '任务已完成，不能取消。'
    case 'cancelled':
      return '任务已经取消。'
    default:
      return `任务当前状态无法取消：${status}`
  }
}
