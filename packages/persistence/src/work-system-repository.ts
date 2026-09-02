import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import type {
  Deliverable,
  GrowthEvidence,
  JsonObject,
  Review,
  TaskAssignment,
  TaskPlanRevision,
  TaskPlanStep,
  TaskRun,
  WorkTask,
  WorkTaskDetail,
  WorkTaskPriority,
  WorkTaskStatus,
  TaskCollaborationPlan,
  AgentRun,
} from '@dsh-cyber/contracts'

import { EntityNotFoundError, PersistenceError } from './errors.js'

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

  getTask(taskId: string): WorkTask | undefined {
    const row = this.#database.prepare('SELECT * FROM work_tasks WHERE id = ?').get(taskId)
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
    return {
      task,
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
function mapTask(row: object): WorkTask { const v = row as Record<string, unknown>; return { id: String(v.id), workspaceId: String(v.workspace_id), worldId: String(v.world_id), title: String(v.title), description: String(v.description), status: v.status as WorkTaskStatus, priority: v.priority as WorkTaskPriority, budget: json<JsonObject>(v.budget_json), createdBy: String(v.created_by), currentPlanRevision: Number(v.current_plan_revision), createdAt: String(v.created_at), updatedAt: String(v.updated_at), ...(optional(v.due_at) === undefined ? {} : { dueAt: optional(v.due_at)! }), ...(optional(v.coordinator_employee_id) === undefined ? {} : { coordinatorEmployeeId: optional(v.coordinator_employee_id)! }) } }
function mapPlan(row: object): TaskPlanRevision { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), revision: Number(v.revision), status: v.status as TaskPlanRevision['status'], summary: String(v.summary), executionMode: v.execution_mode as TaskPlanRevision['executionMode'], createdBy: String(v.created_by), createdAt: String(v.created_at) } }
function mapStep(row: object): TaskPlanStep { const v = row as Record<string, unknown>; return { id: String(v.id), planRevisionId: String(v.plan_revision_id), ordinal: Number(v.ordinal), title: String(v.title), description: String(v.description), requiredSkills: json<string[]>(v.required_skills_json), assignedEmployeeIds: json<string[]>(v.assigned_employee_ids_json), dependsOn: json<string[]>(v.depends_on_json), executionMode: v.execution_mode as TaskPlanStep['executionMode'], expectedOutput: String(v.expected_output), status: v.status as TaskPlanStep['status'] } }
function mapAssignment(row: object): TaskAssignment { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), planRevisionId: String(v.plan_revision_id), stepId: String(v.step_id), employeeId: String(v.employee_id), assignmentReason: json<JsonObject>(v.assignment_reason_json), requiredSkills: json<string[]>(v.required_skills_json), status: v.status as TaskAssignment['status'], createdAt: String(v.created_at), updatedAt: String(v.updated_at) } }
function mapRun(row: object): TaskRun { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), planRevisionId: String(v.plan_revision_id), attempt: Number(v.attempt), workTurnId: String(v.work_turn_id), agentRunIds: json<string[]>(v.agent_run_ids_json), status: v.status as TaskRun['status'], startedAt: String(v.started_at), ...(optional(v.completed_at) === undefined ? {} : { completedAt: optional(v.completed_at)! }), ...(typeof v.cost === 'number' ? { cost: v.cost } : {}), ...(typeof v.latency === 'number' ? { latency: v.latency } : {}), ...(optional(v.error_code) === undefined ? {} : { errorCode: optional(v.error_code)! }) } }
function mapDeliverable(row: object): Deliverable { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), taskRunId: String(v.task_run_id), submittedByEmployeeId: String(v.submitted_by_employee_id), artifactId: String(v.artifact_id), artifactVersionId: Number(v.artifact_version_id), title: String(v.title), summary: String(v.summary), evidenceRefs: json<string[]>(v.evidence_refs_json), version: Number(v.version), status: v.status as Deliverable['status'], createdAt: String(v.created_at), ...(optional(v.step_id) === undefined ? {} : { stepId: optional(v.step_id)! }) } }
function mapReview(row: object): Review { const v = row as Record<string, unknown>; return { id: String(v.id), taskId: String(v.task_id), deliverableId: String(v.deliverable_id), reviewerKind: v.reviewer_kind as Review['reviewerKind'], reviewerId: String(v.reviewer_id), decision: v.decision as Review['decision'], feedback: String(v.feedback), rubric: json<JsonObject>(v.rubric_json), createdAt: String(v.created_at) } }
function mapGrowth(row: object): GrowthEvidence { const v = row as Record<string, unknown>; return { id: String(v.id), workspaceId: String(v.workspace_id), worldId: String(v.world_id), taskId: String(v.task_id), deliverableId: String(v.deliverable_id), employeeId: String(v.employee_id), skillIds: json<string[]>(v.skill_ids_json), outcome: v.outcome as GrowthEvidence['outcome'], summary: String(v.summary), createdAt: String(v.created_at) } }
function planMode(plan: TaskCollaborationPlan): TaskPlanRevision['executionMode'] { const modes = new Set(plan.steps.map((step) => step.executionMode)); return modes.size > 1 ? 'mixed' : modes.has('parallel') ? 'parallel' : 'sequential' }
