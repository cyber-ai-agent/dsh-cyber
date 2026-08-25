import type { IsoTimestamp } from './index.js'

/** A group session is either a discussion or a routed work task. */
export type WorkSessionCollaborationMode = 'discussion' | 'task'

export type TaskCollaborationPlanStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export type TaskCollaborationStepStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'cancelled'

export type TaskCollaborationExecutionMode = 'parallel' | 'sequential'

/** Provider-neutral step persisted by the Task Router. */
export interface TaskCollaborationStep {
  id: string
  planId: string
  ordinal: number
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: TaskCollaborationExecutionMode
  status: TaskCollaborationStepStatus
  errorCode?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/** Durable plan connecting one user task to one world/session/work turn. */
export interface TaskCollaborationPlan {
  id: string
  taskId: string
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  revision: number
  status: TaskCollaborationPlanStatus
  steps: TaskCollaborationStep[]
  errorCode?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

/** Compatibility aliases for callers that prefer shorter names. */
export type TaskCollaborationStatus = TaskCollaborationPlanStatus
export type TaskCollaborationStepExecutionMode = TaskCollaborationExecutionMode
