import { ArrowClockwise, Check, ClipboardText, PaperPlaneTilt, WarningCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'

import type { Deliverable, WorkTask, WorkTaskDetail, WorkTaskSourceTurn, World, WorldArtifact } from '@dsh-cyber/contracts'
import { api } from '../../api.js'
import { useI18n } from '../../i18n/runtime.js'
import type { CyberEmployee } from '../../types.js'
import { subscribeWorldLive } from '../../world-live-client.js'
import './task-workspace.css'

const GROUPS: WorkTask['status'][] = ['draft', 'running', 'waiting-approval', 'waiting-review', 'changes-requested', 'completed', 'failed']

export function TaskWorkspace({ world, employees }: { world: World; employees: CyberEmployee[] }) {
  const { locale, t, formatNumber } = useI18n()
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<WorkTaskDetail>()
  const [artifacts, setArtifacts] = useState<WorldArtifact[]>([])
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      const [taskResult, artifactResult] = await Promise.all([
        api<{ items: WorkTask[] }>(`/api/worlds/${world.id}/tasks`),
        api<{ artifacts: WorldArtifact[] }>(`/api/worlds/${world.id}/artifacts`),
      ])
      setTasks(taskResult.items)
      setArtifacts(artifactResult.artifacts)
      const target = selectedId ?? taskResult.items[0]?.id
      setSelectedId(target)
      if (target !== undefined) setDetail(await api<WorkTaskDetail>(`/api/tasks/${target}`))
      else setDetail(undefined)
      setError(undefined)
    } catch (cause) { setError(localizedTaskError(cause, locale, t('task.error.load', '任务加载失败'))) }
  }, [locale, selectedId, t, world.id])

  useEffect(() => { void load() }, [world.id])
  // A task the host recorded from a conversation lands while this panel is
  // already open. Without this it stayed invisible until the owner switched
  // worlds or wrote something themselves.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    return subscribeWorldLive(world.id, 'world-task', () => { void load() })
  }, [load, world.id])
  useEffect(() => { if (selectedId !== undefined) void api<WorkTaskDetail>(`/api/tasks/${selectedId}`).then(setDetail).catch((cause) => setError(localizedTaskError(cause, locale, t('task.error.detail', '任务详情加载失败')))) }, [locale, selectedId, t])

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(undefined)
    try { await operation(); await load() } catch (cause) { setError(localizedTaskError(cause, locale, t('task.error.operation', '任务操作失败'))) } finally { setBusy(false) }
  }

  return <section className="task-workspace" aria-label={t('task.workspace.title', '任务工作台')} aria-busy={busy}>
    <header className="task-workspace__header"><div><strong>{t('task.workspace.title', '任务工作台')}</strong><span>{t('task.workspace.subtitle', '真实分工、交付与验收')}</span></div><button type="button" onClick={() => setCreating((value) => !value)}><ClipboardText size={16} aria-hidden="true" />{t('task.new', '新建任务')}</button></header>
    {error === undefined ? null : <div className="task-workspace__error" role="alert"><WarningCircle size={16} aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => void load()}>{t('common.retry', '重试')}</button></div>}
    {creating ? <CreateTaskForm employees={employees} disabled={busy} onCancel={() => setCreating(false)} onCreate={(input) => mutate(async () => { const result = await api<{ task: WorkTask }>(`/api/worlds/${world.id}/tasks`, { method: 'POST', body: JSON.stringify(input) }); setSelectedId(result.task.id); setCreating(false) })} /> : null}
    <div className="task-workspace__layout">
      <nav className="task-board" aria-label={t('task.board.label', '任务看板')}>
        {GROUPS.map((group) => { const items = tasks.filter((task) => task.status === group); return items.length === 0 ? null : <section key={group}><header><strong>{taskGroupLabel(group, t)}</strong><span>{formatNumber(items.length)}</span></header>{items.map((task) => <button key={task.id} type="button" className={selectedId === task.id ? 'is-active' : ''} onClick={() => setSelectedId(task.id)}><strong>{task.title}</strong><small>{priorityLabel(task.priority, t)} · v{task.currentPlanRevision}{task.sourceWorkTurnId === undefined ? '' : ` · ${t('task.source.conversation', '来自对话')}`}</small></button>)}</section> })}
        {tasks.length === 0 ? <div className="task-board__empty"><strong>{t('task.empty.title', '还没有任务')}</strong><span>{t('task.empty.description', '新建一个可分工、可交付、可验收的真实任务。')}</span></div> : null}
      </nav>
      <div className="task-detail">{detail === undefined ? <div className="task-board__empty"><strong>{t('task.select', '选择任务查看详情')}</strong></div> : <TaskDetail detail={detail} employees={employees} artifacts={artifacts} busy={busy} mutate={mutate} />}</div>
    </div>
  </section>
}

function CreateTaskForm({ employees, disabled, onCancel, onCreate }: { employees: CyberEmployee[]; disabled: boolean; onCancel(): void; onCreate(input: Record<string, unknown>): Promise<void> }) {
  const { t } = useI18n()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [coordinator, setCoordinator] = useState(employees[0]?.id ?? '')
  return <form className="task-create" onSubmit={(event) => { event.preventDefault(); void onCreate({ title, description, priority, ...(coordinator ? { coordinatorEmployeeId: coordinator } : {}) }) }}>
    <label><span>{t('task.create.title', '任务标题')}</span><input name="title" value={title} maxLength={160} required onChange={(event) => setTitle(event.target.value)} /></label>
    <label><span>{t('task.create.objective', '任务目标')}</span><textarea name="description" value={description} maxLength={8000} required onChange={(event) => setDescription(event.target.value)} /></label>
    <div><label><span>{t('task.create.priority', '优先级')}</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="low">{priorityLabel('low', t)}</option><option value="normal">{priorityLabel('normal', t)}</option><option value="high">{priorityLabel('high', t)}</option><option value="urgent">{priorityLabel('urgent', t)}</option></select></label><label><span>{t('task.create.coordinator', '协调角色')}</span><select value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label></div>
    <footer><button type="button" onClick={onCancel}>{t('common.cancel', '取消')}</button><button type="submit" disabled={disabled || !title.trim() || !description.trim()}>{t('task.create.submit', '创建任务')}</button></footer>
  </form>
}

function TaskDetail({ detail, employees, artifacts, busy, mutate }: { detail: WorkTaskDetail; employees: CyberEmployee[]; artifacts: WorldArtifact[]; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void> }) {
  const { locale, t, formatList, formatNumber } = useI18n()
  const [selectedEmployees, setSelectedEmployees] = useState(() => new Set(employees.map((employee) => employee.id)))
  const [coordinator, setCoordinator] = useState(detail.task.coordinatorEmployeeId ?? employees[0]?.id ?? '')
  // The coordinator has to be someone actually selected. With a single
  // assignee that is simply them. Without this the select can show a name
  // the request will not carry, and the server refuses a coordinator who is
  // not a member — which is how a one-person task failed even after the
  // server started accepting one.
  const effectiveCoordinator = selectedEmployees.has(coordinator) ? coordinator : [...selectedEmployees][0]
  const latestRun = detail.runs.at(-1)
  const submitted = detail.deliverables.findLast((item) => item.status === 'submitted')
  return <>
    <header className="task-detail__header"><div><h2>{detail.task.title}</h2><p>{detail.task.description}</p></div><span className={`task-status task-status--${detail.task.status}`}>{taskStatusLabel(detail.task.status, t)}</span></header>
    {detail.sourceTurn === undefined ? null : <SourceTurn turn={detail.sourceTurn} employees={employees} />}
    {(detail.task.status === 'draft' || detail.task.status === 'changes-requested' || detail.task.status === 'failed') ? <section className="task-action"><h3>{detail.task.status === 'changes-requested' ? t('task.action.feedbackVersion', '按反馈生成新版本') : t('task.action.start', '开始真实协作')}</h3>{detail.sourceTurn?.status === 'completed' && detail.sourceTurn.runs.length > 0 ? <p className="task-action__repeat">{t('task.action.sourceAlreadyRan', '这次对话已经执行过一遍。再次执行会重新产生一次真实副作用。')}</p> : null}<div className="task-employee-picker">{employees.map((employee) => <label key={employee.id}><input type="checkbox" checked={selectedEmployees.has(employee.id)} onChange={(event) => setSelectedEmployees((current) => { const next = new Set(current); if (event.target.checked) next.add(employee.id); else next.delete(employee.id); return next })} /><span><strong>{employee.displayName}</strong><small>{employee.role} · {employee.presence === 'working' ? t('task.action.working', '工作中') : t('task.action.available', '可接任务')}</small></span></label>)}</div><label><span>{t('task.create.coordinator', '协调角色')}</span><select value={effectiveCoordinator ?? ''} onChange={(event) => setCoordinator(event.target.value)}>{employees.filter((employee) => selectedEmployees.has(employee.id)).map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label><button type="button" disabled={busy || selectedEmployees.size < 1} onClick={() => void mutate(() => api(`/api/tasks/${detail.task.id}/execute`, { method: 'POST', body: JSON.stringify({ employeeIds: [...selectedEmployees], ...(effectiveCoordinator === undefined ? {} : { coordinatorEmployeeId: effectiveCoordinator }) }) }))}><PaperPlaneTilt size={16} aria-hidden="true" />{detail.task.status === 'changes-requested' ? t('task.action.newVersion', '生成新版本') : t('task.action.planAndRun', '生成计划并执行')}</button></section> : null}
    <section><h3>{t('task.plan.heading', '计划与分工')}</h3>{detail.plans.length === 0 ? <p>{t('task.plan.empty', '执行后将显示真实计划和选择原因。')}</p> : detail.plans.map((plan) => <div key={plan.id} className="task-plan"><header><strong>{t('task.plan.version', '计划 v{version}', { version: plan.revision })}</strong><span>{taskStatusLabel(plan.status, t)}</span></header>{detail.steps.filter((step) => step.planRevisionId === plan.id).map((step) => <article key={step.id}><div><strong>{step.ordinal}. {step.title}</strong><span>{taskStatusLabel(step.status, t)}</span></div><p>{step.expectedOutput}</p><small>{t('common.role', '角色')}：{formatList(step.assignedEmployeeIds.map((id) => employeeName(employees, id)))} · {t('common.skill', '技能')}：{step.requiredSkills.length > 0 ? formatList(step.requiredSkills) : '—'}</small></article>)}</div>)}</section>
    <details className="dock-detail-fold"><summary>{t('task.execution.heading', '执行与证据')} · {detail.runs.length}</summary>{detail.runs.map((run) => <article key={run.id} className="task-run"><strong>{t('task.execution.attempt', '第 {attempt} 次执行 · {status}', { attempt: run.attempt, status: taskStatusLabel(run.status, t) })}</strong><span>{t('task.execution.workTurn', '工作回合 {id}', { id: run.workTurnId.slice(0, 8) })} · {t('task.execution.agentRuns', '{count} 个角色运行', { count: formatNumber(run.agentRunIds.length) })} · {formatMilliseconds(run.latency ?? 0, locale)}</span></article>)}{detail.assignments.map((assignment) => <details key={assignment.id}><summary>{t('task.execution.reason', '{name} 的选择原因', { name: employeeName(employees, assignment.employeeId) })}</summary><pre>{JSON.stringify(assignment.assignmentReason, null, 2)}</pre></details>)}</details>
    {detail.task.status === 'waiting-review' && latestRun !== undefined && submitted === undefined ? <SubmitDeliverable taskId={detail.task.id} runId={latestRun.id} employees={employees} artifacts={artifacts} busy={busy} mutate={mutate} /> : null}
    <section><h3>{t('task.delivery.heading', '交付与验收')}</h3>{detail.deliverables.length === 0 ? <p>{t('task.delivery.empty', '还没有交付版本。')}</p> : detail.deliverables.map((item) => <DeliverableRow key={item.id} deliverable={item} reviews={detail.reviews.filter((review) => review.deliverableId === item.id)} />)}{submitted === undefined ? null : <ReviewForm deliverable={submitted} busy={busy} mutate={mutate} />}</section>
  </>
}

/**
 * The conversation turn this task came out of, and what that turn did.
 *
 * A draft recorded from a chat message used to say only "来自对话" on its row:
 * the turn behind it could be waiting in the queue, still answering, or long
 * finished, and the panel looked identical in all three cases. It says which
 * turn, how that turn ended and who ran in it — and then says plainly that
 * none of it is this task's own work, because the task has not run and will
 * not until the owner starts it.
 */
function SourceTurn({ turn, employees }: { turn: WorkTaskSourceTurn; employees: CyberEmployee[] }) {
  const { t, formatList, formatNumber } = useI18n()
  return <section className="task-source">
    <h3>{t('task.source.heading', '来源对话')}</h3>
    <p>
      {t('task.source.turn', '提出该任务的回合 {id} · {status}', { id: turn.workTurnId.slice(0, 8), status: taskStatusLabel(turn.status, t) })}
      {' · '}
      {t('task.execution.agentRuns', '{count} 个角色运行', { count: formatNumber(turn.runs.length) })}
    </p>
    {turn.runs.length === 0 ? null : <small>{formatList(turn.runs.map((run) => employeeName(employees, run.employeeId)))}</small>}
    {turn.errorCode === undefined ? null : <small className="task-source__error">{turn.errorCode}</small>}
    <small>{t('task.source.note', '这是提出任务的那次对话，不是任务本身的执行。')}</small>
  </section>
}

function SubmitDeliverable({ taskId, runId, employees, artifacts, busy, mutate }: { taskId: string; runId: string; employees: CyberEmployee[]; artifacts: WorldArtifact[]; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void> }) {
  const { t } = useI18n()
  const activeArtifacts = artifacts.filter((artifact) => artifact.status === 'active')
  const [artifactId, setArtifactId] = useState(activeArtifacts[0]?.id ?? '')
  const artifact = activeArtifacts.find((item) => item.id === artifactId)
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [summary, setSummary] = useState('')
  return <section className="task-action"><h3>{t('task.delivery.submitImmutable', '提交不可变交付版本')}</h3>{activeArtifacts.length === 0 ? <p>{t('task.delivery.publishFirst', '请先在当前世界发布一个产物，再回来提交验收。')}</p> : <><label><span>{t('task.delivery.artifactVersion', '产物版本')}</span><select value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>{activeArtifacts.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.currentVersion}</option>)}</select></label><label><span>{t('task.delivery.submitter', '提交角色')}</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label><label><span>{t('task.delivery.summary', '交付摘要')}</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label><button type="button" disabled={busy || !summary.trim()} onClick={() => artifact === undefined ? undefined : void mutate(() => api(`/api/tasks/${taskId}/deliverables`, { method: 'POST', body: JSON.stringify({ taskRunId: runId, submittedByEmployeeId: employeeId, artifactId: artifact.id, artifactVersionId: artifact.currentVersion, title: artifact.title, summary, evidenceRefs: [`task-run:${runId}`] }) }))}>{t('task.delivery.submitReview', '提交验收')}</button></>}</section>
}

function ReviewForm({ deliverable, busy, mutate }: { deliverable: Deliverable; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void> }) {
  const { t } = useI18n()
  const [feedback, setFeedback] = useState('')
  const decide = (decision: 'accept' | 'request-changes' | 'reject') => mutate(() => api(`/api/deliverables/${deliverable.id}/reviews`, { method: 'POST', body: JSON.stringify({ decision, feedback }) }))
  return <div className="task-review"><label><span>{t('task.review.feedback', '验收反馈')}</span><textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={t('task.review.placeholder', '要求修改或拒绝时必须填写')} /></label><div><button type="button" disabled={busy} onClick={() => void decide('accept')}><Check size={15} />{t('task.review.accept', '接受')}</button><button type="button" disabled={busy || !feedback.trim()} onClick={() => void decide('request-changes')}><ArrowClockwise size={15} />{t('task.review.requestChanges', '要求修改')}</button><button type="button" disabled={busy || !feedback.trim()} onClick={() => void decide('reject')}>{t('task.review.reject', '拒绝')}</button></div></div>
}

function DeliverableRow({ deliverable, reviews }: { deliverable: Deliverable; reviews: WorkTaskDetail['reviews'] }) { const { t, formatNumber } = useI18n(); return <article className="deliverable-row"><div><strong>v{deliverable.version} · {deliverable.title}</strong><span>{taskStatusLabel(deliverable.status, t)}</span></div><p>{deliverable.summary}</p><small>{t('task.delivery.artifactVersion', '产物版本')} {deliverable.artifactId.slice(0, 8)}@v{deliverable.artifactVersionId} · {formatNumber(deliverable.evidenceRefs.length)} {t('common.evidence', '证据')}</small>{reviews.map((review) => <blockquote key={review.id}><strong>{decisionLabel(review.decision, t)}</strong>{review.feedback || t('task.review.approved', '验收通过')}</blockquote>)}</article> }
const employeeName = (employees: CyberEmployee[], id: string) => employees.find((employee) => employee.id === id)?.displayName ?? id
type Translator = ReturnType<typeof useI18n>['t']
const priorityLabel = (priority: WorkTask['priority'], t: Translator) => t(`priority.${priority}`, priority)
const taskStatusLabel = (status: string, t: Translator) => t(`status.${status}`, status)
const taskGroupLabel = (status: WorkTask['status'], t: Translator) => t(`task.group.${status === 'waiting-approval' ? 'waitingApproval' : status === 'waiting-review' ? 'waitingReview' : status === 'changes-requested' ? 'changesRequested' : status}`, taskStatusLabel(status, t))
const decisionLabel = (decision: string, t: Translator) => t(`decision.${decision}`, decision)
const formatMilliseconds = (value: number, locale: string) => new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(value)
const localizedTaskError = (cause: unknown, locale: string, fallback: string) => locale.startsWith('zh') && cause instanceof Error ? cause.message : fallback
