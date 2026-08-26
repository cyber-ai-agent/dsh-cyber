import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../api.js'
import type { CyberEmployee } from '../types.js'
import { normalizeTaskCollaborationPlan, taskPlanPath, type TaskCollaborationPlan, type TaskStepStatus } from './group-collaboration.js'

interface TaskCollaborationSummaryProps {
  worldId: string
  sessionId: string
  employees: CyberEmployee[]
  demoMode: boolean
}

export function TaskCollaborationSummary({ worldId, sessionId, employees, demoMode }: TaskCollaborationSummaryProps) {
  const [plan, setPlan] = useState<TaskCollaborationPlan>()
  const [loading, setLoading] = useState(!demoMode)
  const terminalRef = useRef(false)

  const loadPlan = useCallback(async () => {
    try {
      const value = await api<unknown>(taskPlanPath(sessionId))
      const next = normalizeTaskCollaborationPlan(value, sessionId)
      terminalRef.current = next.status === 'completed' || next.status === 'failed' || next.status === 'interrupted' || next.status === 'cancelled'
      setPlan(next)
    } catch {
      setPlan((current) => current ?? { sessionId, steps: [] })
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (demoMode) {
      setPlan({ sessionId, steps: employees.map((employee) => ({ id: `${sessionId}:${employee.id}`, employeeId: employee.id, employeeIds: [employee.id], role: employee.role, skillIds: [], status: 'pending' })) })
      setLoading(false)
      return undefined
    }
    setLoading(true)
    terminalRef.current = false
    void loadPlan()
    const timer = window.setInterval(() => { if (!terminalRef.current) void loadPlan() }, 4_000)
    return () => { window.clearInterval(timer) }
  }, [demoMode, employees, loadPlan, sessionId])

  return <section className="task-collaboration-summary" aria-label="协作分配">
    <header><div><strong>协作</strong><span>角色分工与步骤状态</span></div>{loading ? <CircleNotch size={16} className="spin" aria-label="正在读取任务分配" /> : null}</header>
    {loading ? <p className="task-collaboration-summary__empty">正在读取任务分配…</p> : plan?.steps.length === 0 ? <p className="task-collaboration-summary__empty">任务分配正在准备，详细执行过程请查看轨迹。</p> : <ol>{plan?.steps.map((step) => {
      const employee = employees.find((item) => item.id === step.employeeId)
      const assignees = step.employeeIds.map((employeeId) => employees.find((item) => item.id === employeeId)?.displayName ?? employeeId).join('、')
      return <li key={step.id} className={`task-collaboration-step task-collaboration-step--${step.status}`}><span className="task-collaboration-step__icon"><TaskStatusIcon status={step.status} /></span><span><strong>{assignees || employee?.displayName || step.role || '角色'}</strong><small>{step.title ?? step.skillLabel ?? step.skillId ?? employee?.role ?? '协作步骤'}</small></span><em>{taskStatusLabel(step.status)}</em></li>
    })}</ol>}
  </section>
}

function TaskStatusIcon({ status }: { status: TaskStepStatus }) {
  if (status === 'completed') return <CheckCircle size={15} aria-hidden="true" />
  if (status === 'blocked') return <WarningCircle size={15} aria-hidden="true" />
  return <span className="task-collaboration-step__dot" aria-hidden="true" />
}

function taskStatusLabel(status: TaskStepStatus): string {
  return ({ pending: '待开始', running: '进行中', completed: '已完成', blocked: '已阻塞' })[status]
}
