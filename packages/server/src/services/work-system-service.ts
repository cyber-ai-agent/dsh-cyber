import type { Deliverable, Review, WorkTask, WorkTaskDetail, WorkTaskPriority, WorkTaskStatus } from '@dsh-cyber/contracts'
import { SqliteUnitOfWork, WorkSystemRepository, type SqliteStore } from '@dsh-cyber/persistence'

import type { GroupTaskCollaborationService } from './group-task-collaboration-service.js'

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

  list(worldId: string, status?: WorkTaskStatus): WorkTask[] { return this.#repository.listTasks(worldId, status) }
  detail(taskId: string): WorkTaskDetail { return this.#repository.detail(taskId) }
  currentWork(employeeId: string): WorkTaskDetail[] { return this.#repository.currentWork(employeeId) }
  taskForDeliverable(deliverableId: string): WorkTask | undefined { return this.#repository.taskForDeliverable(deliverableId) }

  async execute(taskId: string, input: { employeeIds: string[]; coordinatorEmployeeId?: string }): Promise<WorkTaskDetail> {
    let task = this.#repository.requireTask(taskId)
    const world = this.#store.getWorld(task.worldId)
    if (world === undefined) throw new Error('任务世界不可用')
    if (world.status === 'archived') throw new Error(`世界「${world.name}」已归档，无法执行任务。请先恢复该世界。`)
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    if (employeeIds.length < 2) throw new Error('真实任务协作至少需要两名角色')
    for (const employeeId of employeeIds) this.#requireEmployee(task.worldId, employeeId)
    const coordinatorEmployeeId = input.coordinatorEmployeeId ?? task.coordinatorEmployeeId ?? employeeIds[0]!
    if (!employeeIds.includes(coordinatorEmployeeId)) throw new Error('协调角色必须属于任务成员')
    const previousFeedback = this.#repository.detail(task.id).reviews.filter((review) => review.decision === 'request-changes').at(-1)?.feedback
    this.#uow.run(() => {
      if (task.status === 'draft' || task.status === 'changes-requested') task = this.#repository.transitionTask(task.id, [task.status], 'planning')
      if (task.status === 'planning') task = this.#repository.transitionTask(task.id, ['planning'], 'ready')
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

  #requireEmployee(worldId: string, employeeId: string): void {
    const employee = this.#store.getEmployee(employeeId)
    if (employee === undefined || employee.worldId !== worldId || employee.status === 'archived') throw new Error(`任务角色不可用：${employeeId}`)
  }
}
