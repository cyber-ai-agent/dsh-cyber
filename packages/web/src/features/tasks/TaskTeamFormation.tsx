import { ArrowSquareOut, Check, UsersThree } from '@phosphor-icons/react'

import type { WorkTaskDetail } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import type { CyberEmployee } from '../../types.js'

export function TaskTeamFormation({ detail, employees, sessionId, busy, onOpenSession }: { detail: WorkTaskDetail; employees: CyberEmployee[]; sessionId: string; busy: boolean; onOpenSession(sessionId: string): Promise<void> }) {
  const { t, formatList, formatNumber } = useI18n()
  const latestRun = detail.runs.at(-1)
  const assignments = latestRun === undefined ? [] : detail.assignments.filter((item) => item.planRevisionId === latestRun.planRevisionId)
  const invitedIds = latestRun?.participantIds ?? [...new Set([detail.task.coordinatorEmployeeId, ...assignments.map((item) => item.employeeId)].filter((id): id is string => id !== undefined))]
  const invitedNames = invitedIds.map((id) => employees.find((employee) => employee.id === id)?.displayName ?? id)
  return <section className="task-team-formation" aria-label={t('task.team.heading', '任务群聊')}>
    <header><div><UsersThree size={18} aria-hidden="true" /><span><strong>{t('task.team.formed', '团队已组建')}</strong><small>{t('task.team.groupHint', '成员在独立群聊中协作，执行明细继续进入轨迹。')}</small></span></div><button type="button" disabled={busy} onClick={() => void onOpenSession(sessionId)}><ArrowSquareOut size={15} aria-hidden="true" />{t('task.team.open', '进入任务群聊')}</button></header>
    <ol>
      <li className="is-complete"><Check size={14} aria-hidden="true" /><span><strong>{t('task.team.created', '已创建任务群聊')}</strong><small>{detail.task.title}</small></span></li>
      <li className="is-complete"><Check size={14} aria-hidden="true" /><span><strong>{t('task.team.invited', '已邀请 {count} 名角色', { count: formatNumber(invitedIds.length) })}</strong><small>{invitedNames.length > 0 ? formatList(invitedNames) : t('task.team.preparing', '正在准备成员')}</small></span></li>
      <li className={detail.steps.length > 0 ? 'is-complete' : ''}><span className="task-team-formation__dot" aria-hidden="true" /><span><strong>{t('task.team.assigned', '已生成 {count} 项分工', { count: formatNumber(detail.steps.length) })}</strong><small>{t('task.team.status', '当前状态：{status}', { status: t(`status.${detail.task.status}`, detail.task.status) })}</small></span></li>
    </ol>
  </section>
}
