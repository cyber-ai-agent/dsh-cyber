import { Check } from '@phosphor-icons/react'
import { useState } from 'react'
import type { WorkTaskDetail } from '@dsh-cyber/contracts'
import { api } from '../../api.js'
import { useI18n } from '../../i18n/runtime.js'
import type { CyberEmployee } from '../../types.js'
import '../../i18n/task-source-messages.js'

export const isSourceOnlyTask = (detail: WorkTaskDetail) =>
  (detail.task.sourceMessageId !== undefined || detail.task.sourceWorkTurnId !== undefined)
  && detail.task.currentPlanRevision === 0 && detail.runs.length === 0 && detail.plans.length === 0

export function SourceTaskProgress({ detail, employees, busy, mutate }: {
  detail: WorkTaskDetail; employees: CyberEmployee[]; busy: boolean
  mutate(operation: () => Promise<unknown>): Promise<void>
}) {
  const { t, formatNumber, formatList } = useI18n()
  const [note, setNote] = useState('')
  const turn = detail.sourceTurn
  const sourceOnly = isSourceOnlyTask(detail)
  const confirmed = sourceOnly && detail.task.status === 'completed'
  const working = turn !== undefined && (['queued', 'running', 'waiting-approval'].includes(turn.status) || turn.runs.some((run) => ['queued', 'running', 'waiting-approval'].includes(run.status)))
  const canComplete = sourceOnly && turn !== undefined && !working && !['completed', 'cancelled'].includes(detail.task.status)
  const interrupted = turn !== undefined && turn.status !== 'completed'
  const results = turn?.results
  const name = (id: string) => employees.find((employee) => employee.id === id)?.displayName ?? id
  return <section className="task-source" aria-label={t('task.source.heading', '来源对话')}>
    <h3>{confirmed ? t('task.source.confirmed', '已确认完成') : t('task.source.heading', '来源对话')}</h3>
    {sourceOnly ? <p role="status">{confirmed
      ? t('task.source.saved', '完成状态已保存，原对话和已有成果保留。')
      : detail.task.status === 'cancelled' ? t('status.cancelled', '已取消')
      : working
        ? t('task.source.working', '来源对话正在处理，任务进度会自动更新，无需再次执行。')
        : turn?.status === 'completed'
          ? t('task.source.finished', '对话执行已结束，请核对下方结果。目标已达成时可直接确认完成。')
          : t('task.source.interrupted', '来源对话未正常结束。请核对已有成果，已完成的任务可以直接确认，无需重新执行。')}
    </p> : null}
    {turn === undefined ? <p>{t('task.source.pruned', '来源执行记录已清理，任务确认状态不受影响。')}</p> : <>
      <small>{t('task.source.turn', '提出该任务的回合 {id} · {status}', { id: turn.workTurnId.slice(0, 8), status: t(`status.${turn.status}`, turn.status) })}{' · '}{t('task.execution.agentRuns', '{count} 个角色运行', { count: formatNumber(turn.runs.length) })}</small>
      {turn.runs.length === 0 ? null : <small>{formatList(turn.runs.map((run) => `${name(run.employeeId)} · ${t(`status.${run.status}`, run.status)}`))}</small>}
      {turn.errorCode === undefined ? null : <details><summary>{turn.errorCode === 'service-restarted' ? t('task.source.restart', '服务重启时，本次对话的执行记录被标记为中断。') : t('task.source.diagnostic', '查看中断详情')}</summary><code>{turn.errorCode}</code></details>}
      {(results?.messages.length ?? 0) + (results?.artifacts.length ?? 0) === 0 && !working ? <p>{t('task.source.noResult', '没有找到可关联的已保存结果。可以回到原对话核对；系统不会把中断自动算作完成。')}</p> : null}
      {results?.artifacts.map((artifact) => {
        const url = `/api/worlds/${encodeURIComponent(detail.task.worldId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/preview/${artifact.version}`
        return <figure className="task-source-result" key={`${artifact.artifactId}:${artifact.version}`}>
          {artifact.kind === 'image' ? <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={artifact.title} loading="lazy" /></a> : null}
          <figcaption><a href={url} target="_blank" rel="noopener noreferrer">{artifact.title} · v{artifact.version}</a></figcaption>
        </figure>
      })}
      {results?.messages.map((message) => <details className="task-source-result" key={message.id}><summary>{t('task.source.reply', '{name} 的已保存回复', { name: name(message.employeeId) })}</summary><pre>{message.content}</pre>{message.truncated ? <small>{t('task.source.truncated', '此处展示部分内容，完整结果保留在来源对话。')}</small> : null}</details>)}
      {results?.hasMore ? <small>{t('task.source.more', '还有更多结果，请在来源对话或产物中心查看。')}</small> : null}
      {canComplete ? <div className="task-source-confirm">
        {interrupted ? <label><span>{t('task.source.noteLabel', '完成说明')}</span><textarea maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('task.source.notePlaceholder', '例如：图片已生成，并已核对保存的结果。')} /></label> : null}
        <button type="button" disabled={busy || (interrupted && !note.trim())} onClick={() => void mutate(() => api(`/api/tasks/${encodeURIComponent(detail.task.id)}/complete-source`, { method: 'POST', body: JSON.stringify({ sourceWorkTurnId: turn.workTurnId, confirmed: true, ...(note.trim() ? { note: note.trim() } : {}) }) }))}><Check size={16} aria-hidden="true" />{t('task.source.confirm', '确认完成')}</button>
        <small>{t('task.source.confirmHint', '确认只保存你的完成判断，不会再次调用模型或执行工具。')}</small>
      </div> : null}
    </>}
  </section>
}
