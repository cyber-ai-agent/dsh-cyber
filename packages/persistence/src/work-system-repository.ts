import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  Deliverable,
  DomainEventType,
  GrowthEvidence,
  JsonObject,
  ParticipantKind,
  Review,
  TaskAssignment,
  TaskPlanRevision,
  TaskPlanStep,
  TaskRun,
  WorkTask,
  WorkTaskDetail,
  WorkTaskFromSource,
  WorkTaskPriority,
  WorkTaskSourceTurn,
  WorkTaskStatus,
  WorkTurnStatus,
  TaskCollaborationPlan,
  AgentRun,
  AgentRunStatus,
  WorkMessage,
  WorkSession,
  WorkTurn,
} from '@dsh-cyber/contracts'

import { EntityNotFoundError, PersistenceError } from './errors.js'

export interface TaskExecutionStepDraft {
  id: string
  ordinal: number
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: 'parallel' | 'sequential'
}

export interface BeginTaskExecutionInput {
  taskId: string
  workspaceId: string
  worldId: string
  employeeIds: string[]
  coordinatorEmployeeId: string
  prompt: string
  title?: string
  steps: TaskExecutionStepDraft[]
  idempotencyKey?: string
  fingerprintSha256?: string
}

export interface BeginTaskExecutionResult {
  created: boolean
  taskRun: TaskRun
  session: WorkSession
  workTurn: WorkTurn
  ownerMessage: WorkMessage
}

export interface CompleteTaskExecutionInput {
  taskRunId: string
  plan: TaskCollaborationPlan
  agentRuns: AgentRun[]
  coordinatorEmployeeId: string
  latency: number
}

export interface FailTaskExecutionInput {
  taskRunId: string
  errorCode: string
  status?: Extract<TaskRun['status'], 'failed' | 'recovery-required'>
  /** AgentRuns already created for this WorkTurn, including failed ones. */
  agentRunIds?: string[]
}

export class WorkSystemRepository {
  readonly #database: DatabaseSync
  readonly #clock: () => string
  readonly #id: () => string

  constructor(database: DatabaseSync, options: { clock?: () => string; idFactory?: () => string } = {}) {
    this.#database = database
    this.#clock = options.clock ?? (() => new Date().toISOString())
    this.#id = options.idFactory ?? randomUUID
  }

  createTask(input: { workspaceId: string; worldId: string; title: string; description: string; priority: WorkTaskPriority; dueAt?: string; coordinatorEmployeeId?: string; createdBy: string }): WorkTask {
    const now = this.#clock()
    const id = this.#id()
    this.#database.prepare(
      `INSERT INTO work_tasks
       (id, workspace_id, world_id, title, description, status, priority, due_at,
        budget_json, created_by, coordinator_employee_id, current_plan_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, '{}', ?, ?, 0, ?, ?)`,
    ).run(id, input.workspaceId, input.worldId, input.title, input.description, input.priority, input.dueAt ?? null, input.createdBy, input.coordinatorEmployeeId ?? null, now, now)
    return this.getTask(id)!
  }

  /**
   * The one task a conversation turn owns.
   *
   * Creates it on the first call and returns it on every later one — a resend
   * of the same message, the recovery pass after a restart, a retry of the
   * turn. Two callers racing for the same turn both get the same task because
   * the decision is the unique index on `source_work_turn_id`, not a lookup
   * this process did a moment earlier: the loser's insert is a no-op and the
   * read that follows returns the winner. A later call never rewrites an
   * existing task, even when it derived a different title this time; the
   * owner may have edited it since.
   */
  createTaskFromSource(input: { workspaceId: string; worldId: string; workTurnId: string; title: string; description: string; priority: WorkTaskPriority; dueAt?: string; coordinatorEmployeeId?: string; createdBy: string }): WorkTaskFromSource {
    const turn = this.#database.prepare('SELECT workspace_id, world_id, session_id FROM work_turns WHERE id = ?').get(input.workTurnId) as
      | { workspace_id: string; world_id: string; session_id: string }
      | undefined
    if (turn === undefined) throw new EntityNotFoundError(`Source work turn not found: ${input.workTurnId}`)
    if (turn.workspace_id !== input.workspaceId || turn.world_id !== input.worldId) throw new PersistenceError('Source work turn does not belong to this world')
    // The same rule the queue uses to find a turn's prompt again after a restart.
    const message = this.#database.prepare(
      `SELECT id FROM messages
       WHERE session_id = ? AND kind = 'user' AND json_extract(metadata_json, '$.workTurnId') = ?
       ORDER BY sequence LIMIT 1`,
    ).get(turn.session_id, input.workTurnId) as { id: string } | undefined
    if (message === undefined) throw new PersistenceError('Source work turn has no owner message')
    const now = this.#clock()
    const inserted = this.#database.prepare(
      `INSERT INTO work_tasks
       (id, workspace_id, world_id, title, description, status, priority, due_at,
        budget_json, created_by, coordinator_employee_id, current_plan_revision, created_at, updated_at,
        source_work_turn_id, source_message_id)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, '{}', ?, ?, 0, ?, ?, ?, ?)
       ON CONFLICT (source_work_turn_id) DO NOTHING`,
    ).run(this.#id(), input.workspaceId, input.worldId, input.title, input.description, input.priority, input.dueAt ?? null, input.createdBy, input.coordinatorEmployeeId ?? null, now, now, input.workTurnId, message.id)
    const task = this.getTaskBySourceWorkTurn(input.workTurnId)
    if (task === undefined) throw new PersistenceError(`Work Task for source turn ${input.workTurnId} is missing after insert`)
    return { task, created: Number(inserted.changes) === 1 }
  }

  getTask(taskId: string): WorkTask | undefined {
    const row = this.#database.prepare('SELECT * FROM work_tasks WHERE id = ?').get(taskId)
    return row === undefined ? undefined : mapTask(row)
  }

  getTaskBySourceWorkTurn(workTurnId: string): WorkTask | undefined {
    const row = this.#database.prepare('SELECT * FROM work_tasks WHERE source_work_turn_id = ?').get(workTurnId)
    return row === undefined ? undefined : mapTask(row)
  }

  listTasks(worldId: string, status?: WorkTaskStatus): WorkTask[] {
    const rows = status === undefined
      ? this.#database.prepare('SELECT * FROM work_tasks WHERE world_id = ? ORDER BY updated_at DESC, id').all(worldId)
      : this.#database.prepare('SELECT * FROM work_tasks WHERE world_id = ? AND status = ? ORDER BY updated_at DESC, id').all(worldId, status)
    return rows.map(mapTask)
  }

  /**
   * Every recorded execution of every task in a world.
   *
   * This is the durable link from a task to the AgentRuns that worked on it
   * (`agentRunIds` and `workTurnId`); a read model that wants to say "this run
   * belonged to that task" reads it from here and nowhere else.
   */
  listWorldTaskRuns(worldId: string): TaskRun[] {
    return this.#database.prepare(
      `SELECT run.* FROM task_runs run JOIN work_tasks task ON task.id = run.task_id
       WHERE task.world_id = ? ORDER BY run.started_at, run.id`,
    ).all(worldId).map(mapRun)
  }

  transitionTask(taskId: string, from: WorkTaskStatus[], to: WorkTaskStatus): WorkTask {
    const task = this.requireTask(taskId)
    if (!from.includes(task.status)) throw new PersistenceError(`Illegal Work Task transition: ${task.status} -> ${to}`)
    const result = this.#database.prepare('UPDATE work_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run(to, this.#clock(), taskId, task.status)
    if (Number(result.changes) !== 1) throw new PersistenceError('Work Task transition lost a concurrent race')
    return this.requireTask(taskId)
  }

  /**
   * Atomically reserve one Task Center execution before the orchestrator is
   * allowed to plan a runtime turn. The reservation owns the group session,
   * owner message, WorkTurn, formal plan revision, assignments and TaskRun.
   *
   * SQLite's write transaction and the partial unique index on
   * `(task_id, idempotency_key)` are the cross-process claim boundary. A
   * replay returns the original facts and never creates a second WorkTurn.
   */
  beginExecution(input: BeginTaskExecutionInput): BeginTaskExecutionResult {
    const normalized = normalizeBeginTaskExecutionInput(input)
    return this.#transaction(() => {
      const task = this.requireTask(normalized.taskId)
      if (task.workspaceId !== normalized.workspaceId || task.worldId !== normalized.worldId) {
        throw new PersistenceError('Task execution scope does not match the task')
      }

      if (normalized.idempotencyKey !== undefined) {
        const existingRow = this.#database.prepare(
          'SELECT * FROM task_runs WHERE task_id = ? AND idempotency_key = ?',
        ).get(task.id, normalized.idempotencyKey)
        if (existingRow !== undefined) {
          const existing = mapRun(existingRow)
          if (existing.fingerprintSha256 !== normalized.fingerprintSha256) {
            throw new PersistenceError('Task execution idempotency key is already bound to a different fingerprint')
          }
          return { created: false, ...this.#readTaskExecutionFacts(existing) }
        }
      }

      if (!['draft', 'changes-requested', 'failed'].includes(task.status)) {
        throw new PersistenceError(`Task is not executable: ${task.status}`)
      }
      if (normalized.steps.length === 0) throw new PersistenceError('Task execution requires at least one routed step')
      const participantIds = new Set(normalized.employeeIds)
      for (const employeeId of normalized.employeeIds) {
        const employee = this.#database.prepare(
          'SELECT workspace_id, world_id, status FROM employee_instances WHERE id = ?',
        ).get(employeeId) as { workspace_id: string; world_id: string; status: string } | undefined
        if (employee === undefined || employee.workspace_id !== task.workspaceId || employee.world_id !== task.worldId || employee.status === 'archived') {
          throw new PersistenceError(`Task execution employee is unavailable: ${employeeId}`)
        }
      }
      for (const step of normalized.steps) {
        if (step.assignedEmployeeIds.length === 0) throw new PersistenceError(`Task step has no assigned employee: ${step.id}`)
        if (step.assignedEmployeeIds.some((employeeId) => !participantIds.has(employeeId))) {
          throw new PersistenceError(`Task step employee is not a participant: ${step.id}`)
        }
      }

      const now = this.#clock()
      const sessionId = this.#id()
      const workTurnId = this.#id()
      const taskRunId = this.#id()
      const planId = this.#id()
      const title = normalized.title ?? task.title
      const session: WorkSession = {
        id: sessionId,
        workspaceId: task.workspaceId,
        worldId: task.worldId,
        kind: 'group',
        collaborationMode: 'task',
        title,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      }
      this.#database.prepare(
        `INSERT INTO work_sessions
         (id, workspace_id, world_id, kind, collaboration_mode, title, status, created_at, updated_at)
         VALUES (?, ?, ?, 'group', 'task', ?, 'open', ?, ?)`,
      ).run(session.id, session.workspaceId, session.worldId, session.title, now, now)
      this.#appendExecutionEvent({
        workspaceId: task.workspaceId,
        worldId: task.worldId,
        sessionId: session.id,
        type: 'session.created',
        actorId: 'owner',
        actorKind: 'owner',
        payload: { sessionId: session.id, worldId: task.worldId, kind: 'group', title: session.title },
      })

      this.#insertExecutionParticipant(session, 'owner', 'owner', now)
      for (const employeeId of normalized.employeeIds) this.#insertExecutionParticipant(session, employeeId, 'employee', now)

      const workTurn: WorkTurn = {
        id: workTurnId,
        workspaceId: task.workspaceId,
        worldId: task.worldId,
        sessionId: session.id,
        interactionKind: 'task',
        status: 'queued',
        createdAt: now,
        ...(normalized.idempotencyKey === undefined ? {} : { clientTurnId: normalized.idempotencyKey }),
      }
      this.#database.prepare(
        `INSERT INTO work_turns
         (id, workspace_id, world_id, session_id, client_turn_id, interaction_kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'task', 'queued', ?)`,
      ).run(
        workTurn.id,
        workTurn.workspaceId,
        workTurn.worldId,
        workTurn.sessionId,
        normalized.idempotencyKey ?? null,
        now,
      )

      const ownerMessage: WorkMessage = {
        id: this.#id(),
        sessionId: session.id,
        sequence: 1,
        senderId: 'owner',
        senderKind: 'owner',
        kind: 'user',
        content: normalized.prompt,
        metadata: {
          workTaskId: task.id,
          taskRunId,
          workTurnId: workTurn.id,
          interactionKind: 'task',
          collaborationMode: 'task',
          participantIds: normalized.employeeIds,
          ...(normalized.idempotencyKey === undefined ? {} : { idempotencyKey: normalized.idempotencyKey }),
        },
        createdAt: now,
      }
      this.#database.prepare(
        `INSERT INTO messages
         (id, session_id, sequence, sender_id, sender_kind, kind, content, metadata_json, created_at)
         VALUES (?, ?, ?, 'owner', 'owner', 'user', ?, ?, ?)`,
      ).run(ownerMessage.id, ownerMessage.sessionId, ownerMessage.sequence, ownerMessage.content, JSON.stringify(ownerMessage.metadata), now)
      this.#database.prepare('UPDATE work_sessions SET updated_at = ? WHERE id = ?').run(now, session.id)
      this.#appendExecutionEvent({
        workspaceId: task.workspaceId,
        worldId: task.worldId,
        sessionId: session.id,
        type: 'message.appended',
        actorId: 'owner',
        actorKind: 'owner',
        correlationId: session.id,
        payload: { messageId: ownerMessage.id, messageSequence: ownerMessage.sequence, messageKind: 'user', senderId: 'owner' },
      })

      // A failed or interrupted previous attempt must stay visible as history;
      // only an unclosed active revision is retired before this new attempt.
      this.#database.prepare(
        `UPDATE task_plan_revisions SET status = 'failed'
         WHERE task_id = ? AND status = 'active'`,
      ).run(task.id)
      const revision = task.currentPlanRevision + 1
      this.#database.prepare(
        `INSERT INTO task_plan_revisions
         (id, task_id, revision, status, summary, execution_mode, created_by, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      ).run(planId, task.id, revision, `第 ${revision} 版执行计划`, taskPlanMode(normalized.steps), normalized.coordinatorEmployeeId, now)

      const stepIds = new Map<string, string>()
      for (const step of normalized.steps) stepIds.set(step.id, this.#id())
      for (const step of normalized.steps) {
        const stepId = stepIds.get(step.id)!
        const dependencies = step.dependsOn.map((dependency) => {
          const mapped = stepIds.get(dependency)
          if (mapped === undefined) throw new PersistenceError(`Task step dependency is missing: ${dependency}`)
          return mapped
        })
        this.#database.prepare(
          `INSERT INTO task_plan_steps
           (id, plan_revision_id, ordinal, title, description, required_skills_json,
            assigned_employee_ids_json, depends_on_json, execution_mode, expected_output, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(
          stepId,
          planId,
          step.ordinal,
          `步骤 ${step.ordinal}`,
          `执行 ${step.requiredSkills.join('、') || '综合任务'}`,
          JSON.stringify(step.requiredSkills),
          JSON.stringify(step.assignedEmployeeIds),
          JSON.stringify(dependencies),
          step.executionMode,
          '形成可审阅结果或产物',
        )
        for (const employeeId of step.assignedEmployeeIds) {
          this.#database.prepare(
            `INSERT INTO task_assignments
             (id, task_id, plan_revision_id, step_id, employee_id, assignment_reason_json,
              required_skills_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
          ).run(
            this.#id(),
            task.id,
            planId,
            stepId,
            employeeId,
            JSON.stringify({ source: 'group-task-router', requiredSkills: step.requiredSkills, userSelectedPool: true, coordinatorEmployeeId: normalized.coordinatorEmployeeId }),
            JSON.stringify(step.requiredSkills),
            now,
            now,
          )
        }
      }

      const attemptRow = this.#database.prepare(
        'SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM task_runs WHERE task_id = ?',
      ).get(task.id) as { attempt: number }
      this.#database.prepare(
        `INSERT INTO task_runs
         (id, task_id, plan_revision_id, attempt, work_turn_id, agent_run_ids_json,
          status, error_code, started_at, idempotency_key, fingerprint_sha256)
         VALUES (?, ?, ?, ?, ?, '[]', 'running', NULL, ?, ?, ?)`,
      ).run(
        taskRunId,
        task.id,
        planId,
        Number(attemptRow.attempt),
        workTurn.id,
        now,
        normalized.idempotencyKey ?? null,
        normalized.fingerprintSha256 ?? null,
      )
      this.#database.prepare(
        `UPDATE work_tasks
         SET status = 'running', coordinator_employee_id = ?, current_plan_revision = ?, updated_at = ?
         WHERE id = ? AND status IN ('draft', 'changes-requested', 'failed')`,
      ).run(normalized.coordinatorEmployeeId, revision, now, task.id)

      const taskRun = mapRun(this.#database.prepare('SELECT * FROM task_runs WHERE id = ?').get(taskRunId)!)
      return { created: true, taskRun, session, workTurn, ownerMessage }
    })
  }

  getTaskRunByIdempotency(taskId: string, idempotencyKey: string): TaskRun | undefined {
    const key = normalizeRequiredToken(idempotencyKey, 'Task execution idempotency key', 128)
    const row = this.#database.prepare(
      'SELECT * FROM task_runs WHERE task_id = ? AND idempotency_key = ?',
    ).get(taskId, key)
    return row === undefined ? undefined : mapRun(row)
  }

  getTaskRunByWorkTurn(workTurnId: string): TaskRun | undefined {
    const row = this.#database.prepare('SELECT * FROM task_runs WHERE work_turn_id = ?').get(workTurnId)
    return row === undefined ? undefined : mapRun(row)
  }

  getTaskExecution(taskRunId: string): Omit<BeginTaskExecutionResult, 'created'> {
    return this.#readTaskExecutionFacts(this.#requireTaskRun(taskRunId))
  }

  /** Pause every Task Center lifecycle row on the same durable approval. */
  waitExecutionForApproval(taskRunId: string): WorkTaskDetail {
    return this.#transaction(() => {
      const run = this.#requireTaskRun(taskRunId)
      const task = this.requireTask(run.taskId)
      const turn = this.#database.prepare('SELECT status FROM work_turns WHERE id = ?').get(run.workTurnId) as { status: string } | undefined
      if (run.status !== 'running' || task.status !== 'running' || turn?.status !== 'running') {
        throw new PersistenceError('Task execution is not running before approval wait')
      }
      const now = this.#clock()
      this.#database.prepare("UPDATE task_runs SET status = 'waiting-approval' WHERE id = ? AND status = 'running'").run(run.id)
      this.#database.prepare("UPDATE work_tasks SET status = 'waiting-approval', updated_at = ? WHERE id = ? AND status = 'running'").run(now, task.id)
      this.#database.prepare("UPDATE work_turns SET status = 'waiting-approval' WHERE id = ? AND status = 'running'").run(run.workTurnId)
      return this.detail(task.id)
    })
  }

  /** The approval coordinator already resumed the WorkTurn; resume its Task facts too. */
  resumeExecutionAfterApproval(taskRunId: string): WorkTaskDetail {
    return this.#transaction(() => {
      const run = this.#requireTaskRun(taskRunId)
      const task = this.requireTask(run.taskId)
      const turn = this.#database.prepare('SELECT status FROM work_turns WHERE id = ?').get(run.workTurnId) as { status: string } | undefined
      if (run.status !== 'waiting-approval' || task.status !== 'waiting-approval' || turn?.status !== 'running') {
        throw new PersistenceError('Task execution is not ready to resume after approval')
      }
      const now = this.#clock()
      this.#database.prepare("UPDATE task_runs SET status = 'running' WHERE id = ? AND status = 'waiting-approval'").run(run.id)
      this.#database.prepare("UPDATE work_tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting-approval'").run(now, task.id)
      return this.detail(task.id)
    })
  }

  /** Complete the preclaimed TaskRun and publish the formal plan revision. */
  completeExecution(input: CompleteTaskExecutionInput): WorkTaskDetail {
    return this.#transaction(() => {
      const run = this.#requireTaskRun(input.taskRunId)
      if (run.status === 'completed') return this.detail(run.taskId)
      if (run.status !== 'running' && run.status !== 'waiting-approval') {
        throw new PersistenceError(`TaskRun is not completable: ${run.status}`)
      }
      if (input.plan.workTurnId !== run.workTurnId) throw new PersistenceError('TaskRun plan WorkTurn does not match')
      const task = this.requireTask(run.taskId)
      if (task.status !== 'running') throw new PersistenceError('Work Task is not running')
      this.#assertAgentRunsForTask(input.agentRuns, run)
      const now = this.#clock()
      const planRevision = this.#database.prepare(
        'SELECT id FROM task_plan_revisions WHERE id = ? AND task_id = ?',
      ).get(run.planRevisionId, task.id)
      if (planRevision === undefined) throw new PersistenceError('TaskRun plan revision is missing')
      const formalSteps = this.#database.prepare(
        'SELECT id, ordinal FROM task_plan_steps WHERE plan_revision_id = ? ORDER BY ordinal, id',
      ).all(run.planRevisionId) as Array<{ id: string; ordinal: number }>
      for (const formalStep of formalSteps) {
        const resultStep = input.plan.steps.find((step) => step.ordinal === Number(formalStep.ordinal))
        const status = resultStep === undefined
          ? 'failed'
          : resultStep.status === 'completed'
            ? 'completed'
            : resultStep.status === 'failed' || resultStep.status === 'blocked' || resultStep.status === 'interrupted'
              ? 'failed'
              : 'pending'
        this.#database.prepare('UPDATE task_plan_steps SET status = ? WHERE id = ?').run(status, formalStep.id)
        const assignmentStatus = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'assigned'
        this.#database.prepare(
          `UPDATE task_assignments SET status = ?, updated_at = ?
           WHERE plan_revision_id = ? AND step_id = ?`,
        ).run(assignmentStatus, now, run.planRevisionId, formalStep.id)
      }
      this.#database.prepare(
        `UPDATE task_plan_revisions SET status = 'completed' WHERE id = ? AND task_id = ?`,
      ).run(run.planRevisionId, task.id)
      this.#database.prepare(
        `UPDATE task_runs
         SET agent_run_ids_json = ?, status = 'completed', error_code = NULL,
             latency = ?, completed_at = ?
         WHERE id = ? AND status IN ('running', 'waiting-approval')`,
      ).run(JSON.stringify(input.agentRuns.map((agentRun) => agentRun.id)), input.latency, now, run.id)
      this.#database.prepare(
        `UPDATE work_tasks SET status = 'waiting-review', updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, task.id)
      return this.detail(task.id)
    })
  }

  /** Preserve a failed preclaim so it is visible and cannot be replayed as success. */
  failExecution(input: FailTaskExecutionInput): WorkTaskDetail {
    const errorCode = normalizeRequiredToken(input.errorCode, 'Task execution error code', 160)
    const status = input.status ?? 'failed'
    return this.#transaction(() => {
      const run = this.#requireTaskRun(input.taskRunId)
      const task = this.requireTask(run.taskId)
      if (run.status === 'completed') return this.detail(task.id)
      const now = this.#clock()
      const agentRunIds = input.agentRunIds === undefined ? undefined : normalizeExecutionRunIds(input.agentRunIds)
      this.#database.prepare(
        `UPDATE task_runs SET agent_run_ids_json = COALESCE(?, agent_run_ids_json), status = ?, error_code = ?, completed_at = ?
         WHERE id = ? AND status IN ('running', 'waiting-approval')`,
      ).run(agentRunIds === undefined ? null : JSON.stringify(agentRunIds), status, errorCode, now, run.id)
      this.#database.prepare(
        `UPDATE task_plan_revisions SET status = 'failed'
         WHERE id = ? AND status = 'active'`,
      ).run(run.planRevisionId)
      this.#database.prepare(
        `UPDATE task_plan_steps SET status = 'failed'
         WHERE plan_revision_id = ? AND status IN ('pending', 'ready', 'running', 'waiting')`,
      ).run(run.planRevisionId)
      this.#database.prepare(
        `UPDATE task_assignments SET status = 'failed', updated_at = ?
         WHERE plan_revision_id = ? AND status IN ('assigned', 'running', 'waiting')`,
      ).run(now, run.planRevisionId)
      this.#database.prepare(
        `UPDATE work_turns SET status = 'failed', error_code = ?, completed_at = ?
         WHERE id = ? AND status IN ('queued', 'running', 'waiting-approval')`,
      ).run(errorCode, now, run.workTurnId)
      this.#database.prepare(
        `UPDATE work_tasks SET status = 'failed', updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting-approval')`,
      ).run(now, task.id)
      return this.detail(task.id)
    })
  }

  /** Mark actively running executions as recovery-required; approval waits remain resumable. */
  recoverExecutionsAfterRestart(): { recovered: number } {
    return this.#transaction(() => {
      const rows = this.#database.prepare(
        `SELECT id, plan_revision_id, task_id, work_turn_id FROM task_runs
         WHERE status = 'running'`,
      ).all() as Array<{ id: string; plan_revision_id: string; task_id: string; work_turn_id: string }>
      let recovered = 0
      for (const row of rows) {
        const now = this.#clock()
        const agentRunIds = (this.#database.prepare(
          'SELECT id FROM agent_runs WHERE turn_id = ? ORDER BY ordinal, id',
        ).all(row.work_turn_id) as Array<{ id: string }>).map((agentRun) => agentRun.id)
        this.#database.prepare(
          `UPDATE task_runs SET agent_run_ids_json = ?, status = 'recovery-required', error_code = 'service-restarted', completed_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(JSON.stringify(agentRunIds), now, row.id)
        this.#database.prepare(
          `UPDATE task_plan_revisions SET status = 'failed'
           WHERE id = ? AND status = 'active'`,
        ).run(row.plan_revision_id)
        this.#database.prepare(
          `UPDATE task_plan_steps SET status = 'failed'
           WHERE plan_revision_id = ? AND status IN ('pending', 'ready', 'running', 'waiting')`,
        ).run(row.plan_revision_id)
        this.#database.prepare(
          `UPDATE task_assignments SET status = 'failed', updated_at = ?
           WHERE plan_revision_id = ? AND status IN ('assigned', 'running', 'waiting')`,
        ).run(now, row.plan_revision_id)
        this.#database.prepare(
          `UPDATE work_turns SET status = 'failed', error_code = ?, completed_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        ).run('service-restarted', now, row.work_turn_id)
        this.#database.prepare(
          `UPDATE work_tasks SET status = 'failed', updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, row.task_id)
        recovered += 1
      }
      return { recovered }
    })
  }

  recordExecution(input: { taskId: string; plan: TaskCollaborationPlan; agentRuns: AgentRun[]; coordinatorEmployeeId: string; latency: number }): WorkTaskDetail {
    const task = this.requireTask(input.taskId)
    if (task.status !== 'running') throw new PersistenceError('Work Task is not running')
    const revision = task.currentPlanRevision + 1
    const now = this.#clock()
    const planId = this.#id()
    this.#database.prepare(`UPDATE task_plan_revisions SET status = 'superseded' WHERE task_id = ? AND status = 'active'`).run(task.id)
    this.#database.prepare(
      `INSERT INTO task_plan_revisions (id, task_id, revision, status, summary, execution_mode, created_by, created_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)`,
    ).run(planId, task.id, revision, `第 ${revision} 版执行计划`, planMode(input.plan), input.coordinatorEmployeeId, now)
    const stepIds = new Map<string, string>()
    for (const step of input.plan.steps) stepIds.set(step.id, this.#id())
    for (const step of input.plan.steps) {
      const stepId = stepIds.get(step.id)!
      const status = step.status === 'completed' ? 'completed' : step.status === 'running' ? 'running' : step.status === 'failed' || step.status === 'blocked' || step.status === 'interrupted' ? 'failed' : 'pending'
      this.#database.prepare(
        `INSERT INTO task_plan_steps
         (id, plan_revision_id, ordinal, title, description, required_skills_json,
          assigned_employee_ids_json, depends_on_json, execution_mode, expected_output, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(stepId, planId, step.ordinal, `步骤 ${step.ordinal}`, `执行 ${step.requiredSkills.join('、') || '综合任务'}`, JSON.stringify(step.requiredSkills), JSON.stringify(step.assignedEmployeeIds), JSON.stringify(step.dependsOn.map((id) => stepIds.get(id) ?? id)), step.executionMode, '形成可审阅结果或产物', status)
      for (const employeeId of step.assignedEmployeeIds) {
        this.#database.prepare(
          `INSERT INTO task_assignments
           (id, task_id, plan_revision_id, step_id, employee_id, assignment_reason_json,
            required_skills_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(this.#id(), task.id, planId, stepId, employeeId, JSON.stringify({ source: 'group-task-router', requiredSkills: step.requiredSkills, userSelectedPool: true, coordinatorEmployeeId: input.coordinatorEmployeeId }), JSON.stringify(step.requiredSkills), status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'assigned', now, now)
      }
    }
    const attemptRow = this.#database.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM task_runs WHERE task_id = ?').get(task.id) as { attempt: number }
    this.#database.prepare(
      `INSERT INTO task_runs
       (id, task_id, plan_revision_id, attempt, work_turn_id, agent_run_ids_json, status, latency, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(this.#id(), task.id, planId, Number(attemptRow.attempt), input.plan.workTurnId, JSON.stringify(input.agentRuns.map((run) => run.id)), input.latency, input.plan.createdAt, now)
    this.#database.prepare(
      `UPDATE work_tasks SET status = 'waiting-review', coordinator_employee_id = ?,
       current_plan_revision = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    ).run(input.coordinatorEmployeeId, revision, now, task.id)
    return this.detail(task.id)
  }

  markExecutionFailed(taskId: string): WorkTask {
    return this.transitionTask(taskId, ['running'], 'failed')
  }

  createDeliverable(input: { taskId: string; taskRunId: string; submittedByEmployeeId: string; artifactId: string; artifactVersionId: number; title: string; summary: string; evidenceRefs: string[] }): Deliverable {
    const task = this.requireTask(input.taskId)
    if (task.status !== 'waiting-review' && task.status !== 'changes-requested') throw new PersistenceError('Task is not waiting for a deliverable')
    const run = this.#database.prepare('SELECT * FROM task_runs WHERE id = ? AND task_id = ? AND status = ?').get(input.taskRunId, task.id, 'completed')
    if (run === undefined) throw new PersistenceError('Completed TaskRun not found')
    const artifact = this.#database.prepare(
      `SELECT artifact.workspace_id, artifact.world_id FROM world_artifact_versions version
       JOIN world_artifacts artifact ON artifact.id = version.artifact_id
       WHERE version.artifact_id = ? AND version.version = ?`,
    ).get(input.artifactId, input.artifactVersionId) as { workspace_id: string; world_id: string } | undefined
    if (artifact === undefined || artifact.workspace_id !== task.workspaceId || artifact.world_id !== task.worldId) throw new PersistenceError('Artifact version does not belong to this task world')
    const next = this.#database.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM deliverables WHERE task_id = ?').get(task.id) as { version: number }
    const now = this.#clock()
    this.#database.prepare(`UPDATE deliverables SET status = 'superseded' WHERE task_id = ? AND status IN ('submitted','changes-requested')`).run(task.id)
    const id = this.#id()
    this.#database.prepare(
      `INSERT INTO deliverables
       (id, task_id, task_run_id, step_id, submitted_by_employee_id, artifact_id,
        artifact_version_id, title, summary, evidence_refs_json, version, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`,
    ).run(id, task.id, input.taskRunId, input.submittedByEmployeeId, input.artifactId, input.artifactVersionId, input.title, input.summary, JSON.stringify([...new Set(input.evidenceRefs)]), Number(next.version), now)
    this.#database.prepare(`UPDATE work_tasks SET status = 'waiting-review', updated_at = ? WHERE id = ?`).run(now, task.id)
    return this.#getDeliverable(id)!
  }

  review(input: { deliverableId: string; decision: Review['decision']; feedback: string; reviewerId: string; rubric?: JsonObject }): WorkTaskDetail {
    const deliverable = this.#getDeliverable(input.deliverableId)
    if (deliverable === undefined || deliverable.status !== 'submitted') throw new PersistenceError('Deliverable is not waiting for review')
    const task = this.requireTask(deliverable.taskId)
    if (task.status !== 'waiting-review') throw new PersistenceError('Task is not waiting for review')
    const now = this.#clock()
    this.#database.prepare(
      `INSERT INTO reviews (id, task_id, deliverable_id, reviewer_kind, reviewer_id, decision, feedback, rubric_json, created_at)
       VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?)`,
    ).run(this.#id(), task.id, deliverable.id, input.reviewerId, input.decision, input.feedback, JSON.stringify(input.rubric ?? {}), now)
    const deliverableStatus = input.decision === 'accept' ? 'accepted' : input.decision === 'request-changes' ? 'changes-requested' : 'rejected'
    const taskStatus = input.decision === 'accept' ? 'completed' : input.decision === 'request-changes' ? 'changes-requested' : 'failed'
    this.#database.prepare('UPDATE deliverables SET status = ? WHERE id = ? AND status = ?').run(deliverableStatus, deliverable.id, 'submitted')
    this.#database.prepare('UPDATE work_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(taskStatus, now, task.id, 'waiting-review')
    if (input.decision === 'accept' || input.decision === 'reject') this.#recordGrowth(task, deliverable, input.decision === 'accept' ? 'accepted' : 'rejected', input.feedback || deliverable.summary, now)
    return this.detail(task.id)
  }

  detail(taskId: string): WorkTaskDetail {
    const task = this.requireTask(taskId)
    const sourceTurn = this.#sourceTurn(task)
    return {
      task,
      ...(sourceTurn === undefined ? {} : { sourceTurn }),
      plans: this.#database.prepare('SELECT * FROM task_plan_revisions WHERE task_id = ? ORDER BY revision').all(taskId).map(mapPlan),
      steps: this.#database.prepare(`SELECT step.* FROM task_plan_steps step JOIN task_plan_revisions plan ON plan.id = step.plan_revision_id WHERE plan.task_id = ? ORDER BY plan.revision, step.ordinal`).all(taskId).map(mapStep),
      assignments: this.#database.prepare('SELECT * FROM task_assignments WHERE task_id = ? ORDER BY created_at, id').all(taskId).map(mapAssignment),
      runs: this.#database.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt').all(taskId).map(mapRun),
      deliverables: this.#database.prepare('SELECT * FROM deliverables WHERE task_id = ? ORDER BY version').all(taskId).map(mapDeliverable),
      reviews: this.#database.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at, id').all(taskId).map(mapReview),
      growthEvidence: this.#database.prepare('SELECT * FROM growth_evidence WHERE task_id = ? ORDER BY created_at, id').all(taskId).map(mapGrowth),
    }
  }

  currentWork(employeeId: string): WorkTaskDetail[] {
    const taskIds = this.#database.prepare(
      `SELECT DISTINCT assignment.task_id FROM task_assignments assignment
       JOIN work_tasks task ON task.id = assignment.task_id
       WHERE assignment.employee_id = ? AND task.status IN ('running','waiting-approval','waiting-review','changes-requested','recovery-required')
       ORDER BY task.updated_at DESC`,
    ).all(employeeId) as Array<{ task_id: string }>
    return taskIds.map((row) => this.detail(row.task_id))
  }

  taskForDeliverable(deliverableId: string): WorkTask | undefined {
    const row = this.#database.prepare(
      `SELECT task.* FROM work_tasks task JOIN deliverables deliverable ON deliverable.task_id = task.id
       WHERE deliverable.id = ?`,
    ).get(deliverableId)
    return row === undefined ? undefined : mapTask(row)
  }

  requireTask(taskId: string): WorkTask {
    const task = this.getTask(taskId)
    if (task === undefined) throw new EntityNotFoundError(`Work Task not found: ${taskId}`)
    return task
  }

  #requireTaskRun(taskRunId: string): TaskRun {
    const row = this.#database.prepare('SELECT * FROM task_runs WHERE id = ?').get(taskRunId)
    if (row === undefined) throw new EntityNotFoundError(`TaskRun not found: ${taskRunId}`)
    return mapRun(row)
  }

  #readTaskExecutionFacts(taskRun: TaskRun): Omit<BeginTaskExecutionResult, 'created'> {
    const turnRow = this.#database.prepare('SELECT * FROM work_turns WHERE id = ?').get(taskRun.workTurnId)
    if (turnRow === undefined) throw new PersistenceError('TaskRun WorkTurn is missing')
    const turn = turnRow as Record<string, unknown>
    const sessionRow = this.#database.prepare('SELECT * FROM work_sessions WHERE id = ?').get(String(turn.session_id))
    if (sessionRow === undefined) throw new PersistenceError('TaskRun session is missing')
    const messageRow = this.#database.prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND kind = 'user' AND json_extract(metadata_json, '$.workTurnId') = ?
       ORDER BY sequence LIMIT 1`,
    ).get(String(turn.session_id), taskRun.workTurnId)
    if (messageRow === undefined) throw new PersistenceError('TaskRun owner message is missing')
    return {
      taskRun,
      session: mapTaskExecutionSession(sessionRow),
      workTurn: mapTaskExecutionTurn(turnRow),
      ownerMessage: mapTaskExecutionMessage(messageRow),
    }
  }

  #insertExecutionParticipant(
    session: WorkSession,
    participantId: string,
    kind: ParticipantKind,
    joinedAt: string,
  ): void {
    this.#database.prepare(
      `INSERT INTO work_session_participants (session_id, participant_id, kind, joined_at)
       VALUES (?, ?, ?, ?)`,
    ).run(session.id, participantId, kind, joinedAt)
    this.#appendExecutionEvent({
      workspaceId: session.workspaceId,
      worldId: session.worldId,
      sessionId: session.id,
      type: 'session.participant.joined',
      actorId: participantId,
      actorKind: kind,
      correlationId: session.id,
      payload: { sessionId: session.id, participantId, participantKind: kind },
    })
  }

  #appendExecutionEvent(input: {
    workspaceId: string
    worldId: string
    sessionId?: string
    type: DomainEventType
    actorId: string
    actorKind: ParticipantKind
    correlationId?: string
    payload: JsonObject
  }): void {
    const id = this.#id()
    const createdAt = this.#clock()
    this.#database.prepare(
      `INSERT INTO domain_events
       (event_id, workspace_id, world_id, type, actor_id, actor_kind, session_id,
        causation_id, correlation_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      input.worldId,
      input.type,
      input.actorId,
      input.actorKind,
      input.sessionId ?? null,
      input.correlationId ?? null,
      JSON.stringify(input.payload),
      createdAt,
    )
    this.#database.prepare(
      `INSERT INTO sync_outbox
       (event_id, status, attempts, available_at, created_at, updated_at)
       VALUES (?, 'pending', 0, ?, ?, ?)`,
    ).run(id, createdAt, createdAt, createdAt)
  }

  #assertAgentRunsForTask(agentRuns: AgentRun[], taskRun: TaskRun): void {
    const ids = new Set<string>()
    for (const agentRun of agentRuns) {
      if (ids.has(agentRun.id)) throw new PersistenceError(`Duplicate AgentRun in TaskRun: ${agentRun.id}`)
      ids.add(agentRun.id)
      const row = this.#database.prepare(
        `SELECT agent.id FROM agent_runs agent
         JOIN work_turns turn ON turn.id = agent.turn_id
         WHERE agent.id = ? AND agent.turn_id = ? AND agent.session_id = turn.session_id
           AND turn.workspace_id = ? AND turn.world_id = ?`,
      ).get(agentRun.id, taskRun.workTurnId, agentRun.workspaceId, agentRun.worldId)
      if (row === undefined) throw new PersistenceError(`AgentRun does not belong to TaskRun: ${agentRun.id}`)
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * The turn that asked for this task, as it stands right now.
   *
   * Read every time the detail is built, never cached onto the task: the turn
   * is queued when a task from a queued send is first recorded and finishes
   * minutes later, and a snapshot taken at creation would keep saying "排队中"
   * forever. Nothing here is a `task_runs` row — those are attempts at the
   * task, which only the owner can start.
   *
   * `source_work_turn_id` is released when the turn is pruned, so a row that
   * still names a turn names one that exists; the `undefined` below is for the
   * ordinary case of a task with no conversation behind it.
   */
  #sourceTurn(task: WorkTask): WorkTaskSourceTurn | undefined {
    if (task.sourceWorkTurnId === undefined) return undefined
    const turn = this.#database.prepare(
      'SELECT id, session_id, status, error_code, created_at, started_at, completed_at FROM work_turns WHERE id = ?',
    ).get(task.sourceWorkTurnId) as Record<string, unknown> | undefined
    if (turn === undefined) return undefined
    const runs = this.#database.prepare(
      'SELECT id, employee_id, status, error_code, started_at, completed_at FROM agent_runs WHERE turn_id = ? ORDER BY ordinal, id',
    ).all(task.sourceWorkTurnId) as Array<Record<string, unknown>>
    return {
      workTurnId: String(turn.id),
      sessionId: String(turn.session_id),
      status: turn.status as WorkTurnStatus,
      createdAt: String(turn.created_at),
      ...(optional(turn.error_code) === undefined ? {} : { errorCode: optional(turn.error_code)! }),
      ...(optional(turn.started_at) === undefined ? {} : { startedAt: optional(turn.started_at)! }),
      ...(optional(turn.completed_at) === undefined ? {} : { completedAt: optional(turn.completed_at)! }),
      runs: runs.map((run) => ({
        id: String(run.id),
        employeeId: String(run.employee_id),
        status: run.status as AgentRunStatus,
        ...(optional(run.error_code) === undefined ? {} : { errorCode: optional(run.error_code)! }),
        ...(optional(run.started_at) === undefined ? {} : { startedAt: optional(run.started_at)! }),
        ...(optional(run.completed_at) === undefined ? {} : { completedAt: optional(run.completed_at)! }),
      })),
    }
  }

  #getDeliverable(id: string): Deliverable | undefined {
    const row = this.#database.prepare('SELECT * FROM deliverables WHERE id = ?').get(id)
    return row === undefined ? undefined : mapDeliverable(row)
  }

  #recordGrowth(task: WorkTask, deliverable: Deliverable, outcome: GrowthEvidence['outcome'], summary: string, now: string): void {
    const assignment = this.#database.prepare(
      `SELECT required_skills_json FROM task_assignments WHERE task_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(task.id, deliverable.submittedByEmployeeId) as { required_skills_json: string } | undefined
    this.#database.prepare(
      `INSERT OR IGNORE INTO growth_evidence
       (id, workspace_id, world_id, task_id, deliverable_id, employee_id, skill_ids_json, outcome, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(this.#id(), task.workspaceId, task.worldId, task.id, deliverable.id, deliverable.submittedByEmployeeId, assignment?.required_skills_json ?? '[]', outcome, summary, now)
  }
}

const json = <T>(value: unknown): T => JSON.parse(String(value)) as T
const optional = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
function normalizeBeginTaskExecutionInput(input: BeginTaskExecutionInput): BeginTaskExecutionInput {
  const taskId = normalizeRequiredToken(input.taskId, 'Task execution task id', 160)
  const workspaceId = normalizeRequiredToken(input.workspaceId, 'Task execution workspace id', 160)
  const worldId = normalizeRequiredToken(input.worldId, 'Task execution world id', 160)
  const employeeIds = normalizeExecutionEmployeeIds(input.employeeIds)
  const coordinatorEmployeeId = normalizeRequiredToken(input.coordinatorEmployeeId, 'Task execution coordinator id', 160)
  if (!employeeIds.includes(coordinatorEmployeeId)) throw new PersistenceError('Task execution coordinator must be a participant')
  const prompt = normalizeRequiredText(input.prompt, 'Task execution prompt', 8_000)
  const title = input.title === undefined ? undefined : normalizeRequiredText(input.title, 'Task execution title', 160)
  const idempotencyKey = input.idempotencyKey === undefined
    ? undefined
    : normalizeRequiredToken(input.idempotencyKey, 'Task execution idempotency key', 128)
  const fingerprintSha256 = input.fingerprintSha256 === undefined
    ? undefined
    : input.fingerprintSha256.trim().toLowerCase()
  if (idempotencyKey !== undefined && (fingerprintSha256 === undefined || !/^[0-9a-f]{64}$/.test(fingerprintSha256))) {
    throw new PersistenceError('Task execution idempotency key requires a SHA-256 fingerprint')
  }
  if (idempotencyKey === undefined && fingerprintSha256 !== undefined) {
    throw new PersistenceError('Task execution fingerprint requires an idempotency key')
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 3) {
    throw new PersistenceError('Task execution requires 1 to 3 routed steps')
  }
  const stepIds = new Set<string>()
  const steps = input.steps.map((step, index) => {
    const id = normalizeRequiredToken(step.id, 'Task execution step id', 160)
    if (stepIds.has(id)) throw new PersistenceError(`Task execution step id is duplicated: ${id}`)
    stepIds.add(id)
    if (!Number.isSafeInteger(step.ordinal) || step.ordinal !== index + 1) throw new PersistenceError('Task execution step ordinal is invalid')
    const requiredSkills = normalizeStringListForExecution(step.requiredSkills, 'Task execution required skills')
    const assignedEmployeeIds = normalizeExecutionEmployeeIds(step.assignedEmployeeIds)
    if (assignedEmployeeIds.some((employeeId) => !employeeIds.includes(employeeId))) {
      throw new PersistenceError(`Task execution step employee is not a participant: ${id}`)
    }
    if (step.executionMode !== 'parallel' && step.executionMode !== 'sequential') throw new PersistenceError('Task execution mode is invalid')
    const dependsOn = normalizeStringListForExecution(step.dependsOn, 'Task execution dependencies')
    if (dependsOn.includes(id)) throw new PersistenceError(`Task execution step cannot depend on itself: ${id}`)
    return { id, ordinal: index + 1, requiredSkills, assignedEmployeeIds, dependsOn, executionMode: step.executionMode }
  })
  const knownIds = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    if (step.dependsOn.some((dependency) => !knownIds.has(dependency))) throw new PersistenceError(`Task execution dependency is missing: ${step.dependsOn.find((dependency) => !knownIds.has(dependency))}`)
  }
  return {
    taskId,
    workspaceId,
    worldId,
    employeeIds,
    coordinatorEmployeeId,
    prompt,
    ...(title === undefined ? {} : { title }),
    steps,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(fingerprintSha256 === undefined ? {} : { fingerprintSha256 }),
  }
}

function normalizeExecutionEmployeeIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new PersistenceError('Task execution requires at least one employee')
  const result = values.map((value) => normalizeRequiredToken(value, 'Task execution employee id', 160))
  if (new Set(result).size !== result.length) throw new PersistenceError('Task execution employee ids must be unique')
  return result
}

function normalizeExecutionRunIds(values: string[]): string[] {
  if (!Array.isArray(values)) throw new PersistenceError('Task execution AgentRun ids are invalid')
  const result = values.map((value) => normalizeRequiredToken(value, 'Task execution AgentRun id', 160))
  if (new Set(result).size !== result.length) throw new PersistenceError('Task execution AgentRun ids must be unique')
  return result
}

function normalizeStringListForExecution(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new PersistenceError(`${label} must be an array`)
  const result = values.map((value) => normalizeRequiredToken(value, label, 160))
  if (new Set(result).size !== result.length) throw new PersistenceError(`${label} must be unique`)
  return result
}

function normalizeRequiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  // Prompts may contain ordinary line breaks and formatting controls. NUL and
  // DEL are the only values that can corrupt the durable text boundary here.
  if (!normalized || normalized.length > maximum || /[\u0000\u007f]/.test(normalized)) throw new PersistenceError(`${label} is invalid`)
  return normalized
}

function normalizeRequiredToken(value: string, label: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new PersistenceError(`${label} is invalid`)
  return normalized
}

function taskPlanMode(steps: readonly TaskExecutionStepDraft[]): TaskPlanRevision['executionMode'] {
  const modes = new Set(steps.map((step) => step.executionMode))
  return modes.size > 1 ? 'mixed' : modes.has('parallel') ? 'parallel' : 'sequential'
}

function mapTaskExecutionSession(row: object): WorkSession {
  const value = row as Record<string, unknown>
  const session: WorkSession = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    kind: value.kind as WorkSession['kind'],
    title: String(value.title),
    status: value.status as WorkSession['status'],
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  }
  if (value.collaboration_mode === 'discussion' || value.collaboration_mode === 'task') session.collaborationMode = value.collaboration_mode
  return session
}

function mapTaskExecutionTurn(row: object): WorkTurn {
  const value = row as Record<string, unknown>
  const turn: WorkTurn = {
    id: String(value.id),
    workspaceId: String(value.workspace_id),
    worldId: String(value.world_id),
    sessionId: String(value.session_id),
    interactionKind: value.interaction_kind as WorkTurn['interactionKind'],
    status: value.status as WorkTurn['status'],
    createdAt: String(value.created_at),
  }
  if (typeof value.client_turn_id === 'string') turn.clientTurnId = value.client_turn_id
  if (typeof value.error_code === 'string') turn.errorCode = value.error_code
  if (typeof value.started_at === 'string') turn.startedAt = value.started_at
  if (typeof value.completed_at === 'string') turn.completedAt = value.completed_at
  return turn
}

function mapTaskExecutionMessage(row: object): WorkMessage {
  const value = row as Record<string, unknown>
  return {
    id: String(value.id),
    sessionId: String(value.session_id),
    sequence: Number(value.sequence),
    senderId: String(value.sender_id),
    senderKind: value.sender_kind as WorkMessage['senderKind'],
    kind: value.kind as WorkMessage['kind'],
    content: String(value.content),
    metadata: json<JsonObject>(value.metadata_json),
    createdAt: String(value.created_at),
  }
}

function mapTask(row: object): WorkTask { const v = row as Record<string, unknown>; return { id: String(v.id), workspaceId: String(v.workspace_id), worldId: String(v.world_id), title: String(v.title), description: String(v.description), status: v.status as WorkTaskStatus, priority: v.priority as WorkTaskPriority, budget: json<JsonObject>(v.budget_json), createdBy: String(v.created_by), currentPlanRevision: Number(v.current_plan_revision), createdAt: String(v.created_at), updatedAt: String(v.updated_at), ...(optional(v.due_at) === undefined ? {} : { dueAt: optional(v.due_at)! }), ...(optional(v.coordinator_employee_id) === undefined ? {} : { coordinatorEmployeeId: optional(v.coordinator_employee_id)! }), ...(optional(v.source_work_turn_id) === undefined ? {} : { sourceWorkTurnId: optional(v.source_work_turn_id)! }), ...(optional(v.source_message_id) === undefined ? {} : { sourceMessageId: optional(v.source_message_id)! }) } }
function mapPlan(row: object): TaskPlanRevision { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), revision: Number(v.revision), status: v.status as TaskPlanRevision['status'], summary: String(v.summary), executionMode: v.execution_mode as TaskPlanRevision['executionMode'], createdBy: String(v.created_by), createdAt: String(v.created_at) } }
function mapStep(row: object): TaskPlanStep { const v = row as Record<string, unknown>; return { id: String(v.id), planRevisionId: String(v.plan_revision_id), ordinal: Number(v.ordinal), title: String(v.title), description: String(v.description), requiredSkills: json<string[]>(v.required_skills_json), assignedEmployeeIds: json<string[]>(v.assigned_employee_ids_json), dependsOn: json<string[]>(v.depends_on_json), executionMode: v.execution_mode as TaskPlanStep['executionMode'], expectedOutput: String(v.expected_output), status: v.status as TaskPlanStep['status'] } }
function mapAssignment(row: object): TaskAssignment { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), planRevisionId: String(v.plan_revision_id), stepId: String(v.step_id), employeeId: String(v.employee_id), assignmentReason: json<JsonObject>(v.assignment_reason_json), requiredSkills: json<string[]>(v.required_skills_json), status: v.status as TaskAssignment['status'], createdAt: String(v.created_at), updatedAt: String(v.updated_at) } }
function mapRun(row: object): TaskRun { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), planRevisionId: String(v.plan_revision_id), attempt: Number(v.attempt), workTurnId: String(v.work_turn_id), ...(optional(v.idempotency_key) === undefined ? {} : { idempotencyKey: optional(v.idempotency_key)! }), ...(optional(v.fingerprint_sha256) === undefined ? {} : { fingerprintSha256: optional(v.fingerprint_sha256)! }), agentRunIds: json<string[]>(v.agent_run_ids_json), status: v.status as TaskRun['status'], startedAt: String(v.started_at), ...(optional(v.completed_at) === undefined ? {} : { completedAt: optional(v.completed_at)! }), ...(typeof v.cost === 'number' ? { cost: v.cost } : {}), ...(typeof v.latency === 'number' ? { latency: v.latency } : {}), ...(optional(v.error_code) === undefined ? {} : { errorCode: optional(v.error_code)! }) } }
function mapDeliverable(row: object): Deliverable { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), taskRunId: String(v.task_run_id), submittedByEmployeeId: String(v.submitted_by_employee_id), artifactId: String(v.artifact_id), artifactVersionId: Number(v.artifact_version_id), title: String(v.title), summary: String(v.summary), evidenceRefs: json<string[]>(v.evidence_refs_json), version: Number(v.version), status: v.status as Deliverable['status'], createdAt: String(v.created_at), ...(optional(v.step_id) === undefined ? {} : { stepId: optional(v.step_id)! }) } }
function mapReview(row: object): Review { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), deliverableId: String(v.deliverable_id), reviewerKind: v.reviewer_kind as Review['reviewerKind'], reviewerId: String(v.reviewer_id), decision: v.decision as Review['decision'], feedback: String(v.feedback), rubric: json<JsonObject>(v.rubric_json), createdAt: String(v.created_at) } }
function mapGrowth(row: object): GrowthEvidence { const v = row as Record<string, unknown>; return { id: String(v.id), workspaceId: String(v.workspace_id), worldId: String(v.world_id), taskId: String(v.task_id), deliverableId: String(v.deliverable_id), employeeId: String(v.employee_id), skillIds: json<string[]>(v.skill_ids_json), outcome: v.outcome as GrowthEvidence['outcome'], summary: String(v.summary), createdAt: String(v.created_at) } }
function planMode(plan: TaskCollaborationPlan): TaskPlanRevision['executionMode'] { const modes = new Set(plan.steps.map((step) => step.executionMode)); return modes.size > 1 ? 'mixed' : modes.has('parallel') ? 'parallel' : 'sequential' }
