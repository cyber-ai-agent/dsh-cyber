import { PaperPlaneTilt } from '@phosphor-icons/react'
import { useState } from 'react'

import type { WorkTaskDetail } from '@dsh-cyber/contracts'
import { api } from '../../api.js'
import { useI18n } from '../../i18n/runtime.js'
import type { CyberEmployee } from '../../types.js'

export function TaskExecutionForm({ detail, employees, sourceOnly, busy, mutate, onOpenSession }: { detail: WorkTaskDetail; employees: CyberEmployee[]; sourceOnly: boolean; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void>; onOpenSession(sessionId: string): Promise<void> }) {
  const { t } = useI18n()
  const [selectedEmployees, setSelectedEmployees] = useState(() => new Set(employees.map((employee) => employee.id)))
  const [coordinator, setCoordinator] = useState(detail.task.coordinatorEmployeeId ?? employees[0]?.id ?? '')
  const effectiveCoordinator = selectedEmployees.has(coordinator) ? coordinator : [...selectedEmployees][0]
  return <section className="task-action">
    <h3>{detail.task.status === 'changes-requested' ? t('task.action.feedbackVersion', '按反馈生成新版本') : sourceOnly ? t('task.source.repeat', '重新执行任务') : t('task.action.start', '开始真实协作')}</h3>
    {detail.sourceTurn?.status === 'completed' && detail.sourceTurn.runs.length > 0 ? <p className="task-action__repeat">{t('task.action.sourceAlreadyRan', '这次对话已经执行过一遍。再次执行会重新产生一次真实副作用。')}</p> : null}
    <div className="task-team-picker__heading"><strong>{t('task.team.invite', '邀请角色加入任务群聊')}</strong><span>{t('task.team.inviteHint', '开工后会自动创建群聊，并由协调角色按职责分工。')}</span></div>
    <div className="task-employee-picker">{employees.map((employee) => <label key={employee.id}><input type="checkbox" checked={selectedEmployees.has(employee.id)} onChange={(event) => setSelectedEmployees((current) => { const next = new Set(current); if (event.target.checked) next.add(employee.id); else next.delete(employee.id); return next })} /><span><strong>{employee.displayName}</strong><small>{employee.role} · {employee.presence === 'working' ? t('task.action.working', '工作中') : t('task.action.available', '可接任务')}</small></span></label>)}</div>
    <label><span>{t('task.create.coordinator', '协调角色')}</span><select value={effectiveCoordinator ?? ''} onChange={(event) => setCoordinator(event.target.value)}>{employees.filter((employee) => selectedEmployees.has(employee.id)).map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label>
    <button type="button" disabled={busy || selectedEmployees.size < 1} onClick={() => void mutate(async () => {
      const result = await api<WorkTaskDetail>(`/api/tasks/${detail.task.id}/execute`, { method: 'POST', body: JSON.stringify({ employeeIds: [...selectedEmployees], ...(effectiveCoordinator === undefined ? {} : { coordinatorEmployeeId: effectiveCoordinator }) }) })
      const sessionId = result.runs.at(-1)?.sessionId
      if (sessionId !== undefined) await onOpenSession(sessionId)
    })}><PaperPlaneTilt size={16} aria-hidden="true" />{detail.task.status === 'changes-requested' ? t('task.action.newVersion', '生成新版本') : t('task.action.assembleAndRun', '自动组队并开工')}</button>
  </section>
}
