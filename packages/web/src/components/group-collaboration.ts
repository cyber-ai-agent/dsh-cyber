import type { WorkSession, WorkSessionCollaborationMode } from '@dsh-cyber/contracts'

export type CollaborationMode = WorkSessionCollaborationMode
export type TaskStepStatus = 'pending' | 'running' | 'completed' | 'blocked'

export interface CollaborationIntentDetails {
  collaborationMode?: CollaborationMode
}

export interface TaskCollaborationStep {
  id: string
  employeeId: string
  employeeIds: string[]
  role?: string
  skillId?: string
  skillLabel?: string
  skillIds: string[]
  title?: string
  status: TaskStepStatus
}

export interface TaskCollaborationPlan {
  sessionId: string
  title?: string
  status?: 'planned' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  steps: TaskCollaborationStep[]
}

export function collaborationModeOf(value: WorkSession | CollaborationIntentDetails | undefined): CollaborationMode {
  return value !== undefined && value.collaborationMode === 'task' ? 'task' : 'discussion'
}

export function taskPlanPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/task-plan`
}

export function normalizeTaskCollaborationPlan(value: unknown, sessionId: string): TaskCollaborationPlan {
  const skillLabels = isRecord(value) && isRecord(value.skillLabels) ? value.skillLabels : {}
  const root = isRecord(value) && isRecord(value.collaborationPlan)
    ? value.collaborationPlan
    : isRecord(value) && isRecord(value.plan)
      ? value.plan
      : value
  const stepsValue = isRecord(root) && Array.isArray(root.steps) ? root.steps : []
  const steps = stepsValue.flatMap((item, index) => {
    if (!isRecord(item)) return []
    const employeeIds = Array.isArray(item.assignedEmployeeIds)
      ? item.assignedEmployeeIds.filter((id): id is string => typeof id === 'string')
      : typeof item.employeeId === 'string' ? [item.employeeId] : []
    const employeeId = employeeIds[0]
    if (employeeId === undefined) return []
    const skillIds = Array.isArray(item.requiredSkills)
      ? item.requiredSkills.flatMap((skill) => typeof skill === 'string' ? [skill] : isRecord(skill) && typeof skill.id === 'string' ? [skill.id] : [])
      : typeof item.skillId === 'string' ? [item.skillId] : []
    const status = item.status === 'running' ? 'running' : item.status === 'completed' ? 'completed' : item.status === 'failed' || item.status === 'interrupted' || item.status === 'cancelled' ? 'blocked' : 'pending'
    return [{
      id: typeof item.id === 'string' ? item.id : `${sessionId}:step:${index}`,
      employeeId,
      employeeIds,
      ...(typeof item.role === 'string' ? { role: item.role } : {}),
      ...(skillIds[0] === undefined ? {} : { skillId: skillIds[0] }),
      ...(skillIds.length === 0 ? {} : {
        skillLabel: skillIds.map((skillId) => typeof skillLabels[skillId] === 'string' ? skillLabels[skillId] : '未命名技能').join('、'),
      }),
      skillIds,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      status,
    } satisfies TaskCollaborationStep]
  })
  return {
    sessionId,
    ...(isRecord(root) && typeof root.title === 'string' ? { title: root.title } : {}),
    ...(isRecord(root) && isTaskPlanStatus(root.status) ? { status: root.status } : {}),
    steps,
  }
}

function isTaskPlanStatus(value: unknown): value is NonNullable<TaskCollaborationPlan['status']> {
  return value === 'planned' || value === 'running' || value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'cancelled'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
