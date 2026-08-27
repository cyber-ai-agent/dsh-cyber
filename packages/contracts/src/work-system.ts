import type { IsoTimestamp, JsonObject } from './index.js'

export type WorkTaskStatus = 'draft' | 'planning' | 'ready' | 'running' | 'waiting-approval' | 'waiting-review' | 'changes-requested' | 'completed' | 'failed' | 'cancelled' | 'recovery-required'
export type WorkTaskPriority = 'low' | 'normal' | 'high' | 'urgent'

export interface WorkTask {
  id: string
  workspaceId: string
  worldId: string
  title: string
  description: string
  status: WorkTaskStatus
  priority: WorkTaskPriority
  dueAt?: IsoTimestamp
  budget: JsonObject
  createdBy: string
  coordinatorEmployeeId?: string
  currentPlanRevision: number
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type TaskPlanRevisionStatus = 'draft' | 'active' | 'superseded' | 'completed' | 'failed'
export type TaskPlanStepStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export interface TaskPlanRevision {
  id: string
  taskId: string
  revision: number
  status: TaskPlanRevisionStatus
  summary: string
  executionMode: 'parallel' | 'sequential' | 'mixed'
  createdBy: string
  createdAt: IsoTimestamp
}

export interface TaskPlanStep {
  id: string
  planRevisionId: string
  ordinal: number
  title: string
  description: string
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: 'parallel' | 'sequential'
  expectedOutput: string
  status: TaskPlanStepStatus
}

export type AssignmentStatus = 'assigned' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export interface TaskAssignment {
  id: string
  taskId: string
  planRevisionId: string
  stepId: string
  employeeId: string
  assignmentReason: JsonObject
  requiredSkills: string[]
  status: AssignmentStatus
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface TaskRun {
  id: string
  taskId: string
  planRevisionId: string
  attempt: number
  workTurnId: string
  agentRunIds: string[]
  status: 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled' | 'recovery-required'
  cost?: number
  latency?: number
  errorCode?: string
  startedAt: IsoTimestamp
  completedAt?: IsoTimestamp
}

export type DeliverableStatus = 'draft' | 'submitted' | 'accepted' | 'changes-requested' | 'rejected' | 'superseded'
export interface Deliverable {
  id: string
  taskId: string
  taskRunId: string
  stepId?: string
  submittedByEmployeeId: string
  artifactId: string
  artifactVersionId: number
  title: string
  summary: string
  evidenceRefs: string[]
  version: number
  status: DeliverableStatus
  createdAt: IsoTimestamp
}

export interface Review {
  id: string
  taskId: string
  deliverableId: string
  reviewerKind: 'owner' | 'employee' | 'system'
  reviewerId: string
  decision: 'accept' | 'request-changes' | 'reject'
  feedback: string
  rubric: JsonObject
  createdAt: IsoTimestamp
}

export interface GrowthEvidence {
  id: string
  workspaceId: string
  worldId: string
  taskId: string
  deliverableId: string
  employeeId: string
  skillIds: string[]
  outcome: 'accepted' | 'rejected'
  summary: string
  createdAt: IsoTimestamp
}

export interface WorkTaskDetail {
  task: WorkTask
  plans: TaskPlanRevision[]
  steps: TaskPlanStep[]
  assignments: TaskAssignment[]
  runs: TaskRun[]
  deliverables: Deliverable[]
  reviews: Review[]
  growthEvidence: GrowthEvidence[]
}

export class WorkSystemContractError extends Error {
  readonly code = 'work_system_contract_invalid'
  constructor(message: string) { super(message); this.name = 'WorkSystemContractError' }
}

export function parseCreateWorkTask(value: unknown): { title: string; description: string; priority: WorkTaskPriority; dueAt?: string; coordinatorEmployeeId?: string } {
  const input = record(value)
  const title = text(input.title, '任务标题', 160)
  const description = text(input.description, '任务目标', 8_000)
  const priority = input.priority === undefined ? 'normal' : input.priority
  if (priority !== 'low' && priority !== 'normal' && priority !== 'high' && priority !== 'urgent') throw new WorkSystemContractError('任务优先级无效')
  const dueAt = optionalText(input.dueAt, '截止时间', 64)
  if (dueAt !== undefined && Number.isNaN(Date.parse(dueAt))) throw new WorkSystemContractError('截止时间必须是 ISO 时间')
  const coordinatorEmployeeId = optionalText(input.coordinatorEmployeeId, '协调角色', 160)
  return { title, description, priority, ...(dueAt === undefined ? {} : { dueAt }), ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }) }
}

export function parseReviewDecision(value: unknown): { decision: Review['decision']; feedback: string } {
  const input = record(value)
  const decision = input.decision
  if (decision !== 'accept' && decision !== 'request-changes' && decision !== 'reject') throw new WorkSystemContractError('验收决定无效')
  const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : ''
  if (decision !== 'accept' && !feedback) throw new WorkSystemContractError('要求修改或拒绝时必须填写反馈')
  if (feedback.length > 8_000) throw new WorkSystemContractError('验收反馈过长')
  return { decision, feedback }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorkSystemContractError('请求必须是对象')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new WorkSystemContractError(`${label}不能为空`)
  if (value.trim().length > maximum) throw new WorkSystemContractError(`${label}过长`)
  return value.trim()
}
function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, label, maximum)
}
