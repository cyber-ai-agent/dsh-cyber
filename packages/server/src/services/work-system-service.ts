import { parseCreateWorkTask, type Deliverable, type Review, type WorkTask, type WorkTaskDetail, type WorkTaskFromSource, type WorkTaskPriority, type WorkTaskStatus, type WorkTurnStatus } from '@dsh-cyber/contracts'
import { SqliteUnitOfWork, WorkSystemRepository, type SqliteStore } from '@dsh-cyber/persistence'

import type { GroupTaskCollaborationService } from './group-task-collaboration-service.js'
import { ServiceError } from './service-error.js'

/**
 * States the owner may start an execution from. `failed` is included so a
 * task that lost its turn (model refusal, rejected review, restart) is retried
 * on the same row: plans, runs, deliverables and reviews of earlier attempts
 * stay as history and the next attempt number continues from them.
 */
const EXECUTABLE_STATUSES: readonly WorkTaskStatus[] = ['draft', 'changes-requested', 'failed']

/**
 * Source-turn states that mean the work is still in someone else's hands.
 *
 * `waiting-approval` counts: the turn is paused on a decision and will carry on
 * afterwards, so the work it was asked for has not finished either.
 */
const UNSETTLED_SOURCE_TURN: readonly WorkTurnStatus[] = ['queued', 'running', 'waiting-approval']

export class WorkSystemService {
  readonly #store: SqliteStore
  readonly #repository: WorkSystemRepository
  readonly #uow: SqliteUnitOfWork
  readonly #groupTasks: GroupTaskCollaborationService

  constructor(options: { store: SqliteStore; groupTasks: GroupTaskCollaborationService }) {
    this.#store = options.store
    this.#repository = new WorkSystemRepository(options.store.database)
    this.#uow = new SqliteUnitOfWork(options.store.database)
    this.#groupTasks = options.groupTasks
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
    return this.#uow.run(() => this.#repository.createTaskFromSource({
      ...draft, workspaceId: world.workspaceId, worldId: world.id, workTurnId: turn.id, createdBy: 'owner',
    }))
  }

  list(worldId: string, status?: WorkTaskStatus): WorkTask[] { return this.#repository.listTasks(worldId, status) }
  taskForSourceTurn(workTurnId: string): WorkTask | undefined { return this.#repository.getTaskBySourceWorkTurn(workTurnId) }
  detail(taskId: string): WorkTaskDetail { return this.#repository.detail(taskId) }
  currentWork(employeeId: string): WorkTaskDetail[] { return this.#repository.currentWork(employeeId) }
  taskForDeliverable(deliverableId: string): WorkTask | undefined { return this.#repository.taskForDeliverable(deliverableId) }

  async execute(taskId: string, input: { employeeIds: string[]; coordinatorEmployeeId?: string }): Promise<WorkTaskDetail> {
    let task = this.#repository.requireTask(taskId)
    const world = this.#store.getWorld(task.worldId)
    if (world === undefined) throw new Error('任务世界不可用')
    if (world.status === 'archived') throw new Error(`世界「${world.name}」已归档，无法执行任务。请先恢复该世界。`)
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 1) throw new Error('任务至少需要一名角色')
    for (const employeeId of employeeIds) this.#requireEmployee(task.worldId, employeeId)
    // A sole assignee coordinates their own task. The coordinator chosen at
    // creation only binds while the roster can still contain them.
    const coordinatorEmployeeId = input.coordinatorEmployeeId ?? (employeeIds.length === 1 ? employeeIds[0]! : task.coordinatorEmployeeId ?? employeeIds[0]!)
    if (!employeeIds.includes(coordinatorEmployeeId)) throw new Error('协调角色必须属于任务成员')
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
    const previousFeedback = this.#repository.detail(task.id).reviews.filter((review) => review.decision === 'request-changes').at(-1)?.feedback
    this.#uow.run(() => {
      task = this.#repository.transitionTask(task.id, [...EXECUTABLE_STATUSES], 'planning')
      task = this.#repository.transitionTask(task.id, ['planning'], 'ready')
      task = this.#repository.transitionTask(task.id, ['ready'], 'running')
    })
    const started = Date.now()
    try {
      const prompt = previousFeedback === undefined
        ? `${task.title}\n\n${task.description}`
        : `${task.title}\n\n${task.description}\n\n[上一版验收反馈]\n${previousFeedback}\n请生成新版本，不要覆盖旧交付。`
      const result = await this.#groupTasks.run({
        workspaceId: task.workspaceId,
        worldId: task.worldId,
        employeeIds,
        coordinatorEmployeeId,
        prompt,
        transformedPrompt: prompt,
        title: task.title,
        metadata: { workTaskId: task.id },
      })
      const runs = this.#store.listTurnAgentRuns(result.workTurnId)
      return this.#uow.run(() => this.#repository.recordExecution({
        taskId: task.id,
        plan: result.plan,
        agentRuns: runs,
        coordinatorEmployeeId,
        latency: Date.now() - started,
      }))
    } catch (error) {
      this.#uow.run(() => this.#repository.markExecutionFailed(task.id))
      throw error
    }
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
    let failed = 0
    this.#uow.run(() => {
      for (const workspace of this.#store.listWorkspaces()) {
        for (const world of this.#store.listWorlds(workspace.id, true)) {
          for (const task of this.#repository.listTasks(world.id, 'running')) {
            this.#repository.markExecutionFailed(task.id)
            failed += 1
          }
        }
      }
    })
    return { failed }
  }

  #requireEmployee(worldId: string, employeeId: string): void {
    const employee = this.#store.getEmployee(employeeId)
    if (employee === undefined || employee.worldId !== worldId || employee.status === 'archived') throw new Error(`任务角色不可用：${employeeId}`)
  }
}
