import { ArrowClockwise, Check, ClipboardText, PaperPlaneTilt, WarningCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'

import type { Deliverable, WorkTask, WorkTaskDetail, World, WorldArtifact } from '@dsh-cyber/contracts'
import { api } from '../../api.js'
import type { CyberEmployee } from '../../types.js'
import './task-workspace.css'

const GROUPS: Array<{ status: WorkTask['status']; label: string }> = [
  { status: 'draft', label: '待规划' },
  { status: 'running', label: '进行中' },
  { status: 'waiting-approval', label: '等待审批' },
  { status: 'waiting-review', label: '等待验收' },
  { status: 'changes-requested', label: '要求修改' },
  { status: 'completed', label: '已完成' },
  { status: 'failed', label: '失败' },
]

export function TaskWorkspace({ world, employees }: { world: World; employees: CyberEmployee[] }) {
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : '任务加载失败') }
  }, [selectedId, world.id])

  useEffect(() => { void load() }, [world.id])
  useEffect(() => { if (selectedId !== undefined) void api<WorkTaskDetail>(`/api/tasks/${selectedId}`).then(setDetail).catch((cause) => setError(cause instanceof Error ? cause.message : '任务详情加载失败')) }, [selectedId])

  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(undefined)
    try { await operation(); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : '任务操作失败') } finally { setBusy(false) }
  }

  return <section className="task-workspace" aria-label="任务工作台" aria-busy={busy}>
    <header className="task-workspace__header"><div><strong>任务工作台</strong><span>真实分工、交付与验收</span></div><button type="button" onClick={() => setCreating((value) => !value)}><ClipboardText size={16} aria-hidden="true" />新建任务</button></header>
    {error === undefined ? null : <div className="task-workspace__error" role="alert"><WarningCircle size={16} aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
    {creating ? <CreateTaskForm employees={employees} disabled={busy} onCancel={() => setCreating(false)} onCreate={(input) => mutate(async () => { const result = await api<{ task: WorkTask }>(`/api/worlds/${world.id}/tasks`, { method: 'POST', body: JSON.stringify(input) }); setSelectedId(result.task.id); setCreating(false) })} /> : null}
    <div className="task-workspace__layout">
      <nav className="task-board" aria-label="任务看板">
        {GROUPS.map((group) => { const items = tasks.filter((task) => task.status === group.status); return items.length === 0 ? null : <section key={group.status}><header><strong>{group.label}</strong><span>{items.length}</span></header>{items.map((task) => <button key={task.id} type="button" className={selectedId === task.id ? 'is-active' : ''} onClick={() => setSelectedId(task.id)}><strong>{task.title}</strong><small>{priorityLabel(task.priority)} · v{task.currentPlanRevision}</small></button>)}</section> })}
        {tasks.length === 0 ? <div className="task-board__empty"><strong>还没有任务</strong><span>新建一个可分工、可交付、可验收的真实任务。</span></div> : null}
      </nav>
      <div className="task-detail">{detail === undefined ? <div className="task-board__empty"><strong>选择任务查看详情</strong></div> : <TaskDetail detail={detail} employees={employees} artifacts={artifacts} busy={busy} mutate={mutate} />}</div>
    </div>
  </section>
}

function CreateTaskForm({ employees, disabled, onCancel, onCreate }: { employees: CyberEmployee[]; disabled: boolean; onCancel(): void; onCreate(input: Record<string, unknown>): Promise<void> }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [coordinator, setCoordinator] = useState(employees[0]?.id ?? '')
  return <form className="task-create" onSubmit={(event) => { event.preventDefault(); void onCreate({ title, description, priority, ...(coordinator ? { coordinatorEmployeeId: coordinator } : {}) }) }}>
    <label><span>任务标题</span><input name="title" value={title} maxLength={160} required onChange={(event) => setTitle(event.target.value)} /></label>
    <label><span>任务目标</span><textarea name="description" value={description} maxLength={8000} required onChange={(event) => setDescription(event.target.value)} /></label>
    <div><label><span>优先级</span><select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option><option value="urgent">紧急</option></select></label><label><span>协调角色</span><select value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label></div>
    <footer><button type="button" onClick={onCancel}>取消</button><button type="submit" disabled={disabled || !title.trim() || !description.trim()}>创建任务</button></footer>
  </form>
}

function TaskDetail({ detail, employees, artifacts, busy, mutate }: { detail: WorkTaskDetail; employees: CyberEmployee[]; artifacts: WorldArtifact[]; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void> }) {
  const [selectedEmployees, setSelectedEmployees] = useState(() => new Set(employees.map((employee) => employee.id)))
  const [coordinator, setCoordinator] = useState(detail.task.coordinatorEmployeeId ?? employees[0]?.id ?? '')
  const latestRun = detail.runs.at(-1)
  const submitted = detail.deliverables.findLast((item) => item.status === 'submitted')
  return <>
    <header className="task-detail__header"><div><h2>{detail.task.title}</h2><p>{detail.task.description}</p></div><span className={`task-status task-status--${detail.task.status}`}>{taskStatusLabel(detail.task.status)}</span></header>
    {(detail.task.status === 'draft' || detail.task.status === 'changes-requested' || detail.task.status === 'failed') ? <section className="task-action"><h3>{detail.task.status === 'changes-requested' ? '按反馈生成新版本' : '开始真实协作'}</h3><div className="task-employee-picker">{employees.map((employee) => <label key={employee.id}><input type="checkbox" checked={selectedEmployees.has(employee.id)} onChange={(event) => setSelectedEmployees((current) => { const next = new Set(current); if (event.target.checked) next.add(employee.id); else next.delete(employee.id); return next })} /><span><strong>{employee.displayName}</strong><small>{employee.role} · {employee.presence === 'working' ? '工作中' : '可接任务'}</small></span></label>)}</div><label><span>协调角色</span><select value={coordinator} onChange={(event) => setCoordinator(event.target.value)}>{employees.filter((employee) => selectedEmployees.has(employee.id)).map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label><button type="button" disabled={busy || selectedEmployees.size < 2} onClick={() => void mutate(() => api(`/api/tasks/${detail.task.id}/execute`, { method: 'POST', body: JSON.stringify({ employeeIds: [...selectedEmployees], coordinatorEmployeeId: coordinator }) }))}><PaperPlaneTilt size={16} aria-hidden="true" />{detail.task.status === 'changes-requested' ? '生成新版本' : '生成计划并执行'}</button></section> : null}
    <section><h3>计划与分工</h3>{detail.plans.length === 0 ? <p>执行后将显示真实计划和选择原因。</p> : detail.plans.map((plan) => <div key={plan.id} className="task-plan"><header><strong>计划 v{plan.revision}</strong><span>{plan.status}</span></header>{detail.steps.filter((step) => step.planRevisionId === plan.id).map((step) => <article key={step.id}><div><strong>{step.ordinal}. {step.title}</strong><span>{step.status}</span></div><p>{step.expectedOutput}</p><small>角色：{step.assignedEmployeeIds.map((id) => employeeName(employees, id)).join('、')} · Skill：{step.requiredSkills.join('、') || '综合处理'}</small></article>)}</div>)}</section>
    <section><h3>执行与证据</h3>{detail.runs.map((run) => <article key={run.id} className="task-run"><strong>第 {run.attempt} 次执行 · {run.status}</strong><span>WorkTurn {run.workTurnId.slice(0, 8)} · {run.agentRunIds.length} 个 AgentRun · {run.latency ?? 0}ms</span></article>)}{detail.assignments.map((assignment) => <details key={assignment.id}><summary>{employeeName(employees, assignment.employeeId)} 的选择原因</summary><pre>{JSON.stringify(assignment.assignmentReason, null, 2)}</pre></details>)}</section>
    {detail.task.status === 'waiting-review' && latestRun !== undefined && submitted === undefined ? <SubmitDeliverable taskId={detail.task.id} runId={latestRun.id} employees={employees} artifacts={artifacts} busy={busy} mutate={mutate} /> : null}
    <section><h3>交付与验收</h3>{detail.deliverables.length === 0 ? <p>还没有交付版本。</p> : detail.deliverables.map((item) => <DeliverableRow key={item.id} deliverable={item} reviews={detail.reviews.filter((review) => review.deliverableId === item.id)} />)}{submitted === undefined ? null : <ReviewForm deliverable={submitted} busy={busy} mutate={mutate} />}</section>
  </>
}

function SubmitDeliverable({ taskId, runId, employees, artifacts, busy, mutate }: { taskId: string; runId: string; employees: CyberEmployee[]; artifacts: WorldArtifact[]; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void> }) {
  const activeArtifacts = artifacts.filter((artifact) => artifact.status === 'active')
  const [artifactId, setArtifactId] = useState(activeArtifacts[0]?.id ?? '')
  const artifact = activeArtifacts.find((item) => item.id === artifactId)
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [summary, setSummary] = useState('')
  return <section className="task-action"><h3>提交不可变交付版本</h3>{activeArtifacts.length === 0 ? <p>请先在当前世界发布一个产物，再回来提交验收。</p> : <><label><span>产物版本</span><select value={artifactId} onChange={(event) => setArtifactId(event.target.value)}>{activeArtifacts.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.currentVersion}</option>)}</select></label><label><span>提交角色</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName}</option>)}</select></label><label><span>交付摘要</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label><button type="button" disabled={busy || !summary.trim()} onClick={() => artifact === undefined ? undefined : void mutate(() => api(`/api/tasks/${taskId}/deliverables`, { method: 'POST', body: JSON.stringify({ taskRunId: runId, submittedByEmployeeId: employeeId, artifactId: artifact.id, artifactVersionId: artifact.currentVersion, title: artifact.title, summary, evidenceRefs: [`task-run:${runId}`] }) }))}>提交验收</button></>}</section>
}

function ReviewForm({ deliverable, busy, mutate }: { deliverable: Deliverable; busy: boolean; mutate(operation: () => Promise<unknown>): Promise<void> }) {
  const [feedback, setFeedback] = useState('')
  const decide = (decision: 'accept' | 'request-changes' | 'reject') => mutate(() => api(`/api/deliverables/${deliverable.id}/reviews`, { method: 'POST', body: JSON.stringify({ decision, feedback }) }))
  return <div className="task-review"><label><span>验收反馈</span><textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="要求修改或拒绝时必须填写" /></label><div><button type="button" disabled={busy} onClick={() => void decide('accept')}><Check size={15} />接受</button><button type="button" disabled={busy || !feedback.trim()} onClick={() => void decide('request-changes')}><ArrowClockwise size={15} />要求修改</button><button type="button" disabled={busy || !feedback.trim()} onClick={() => void decide('reject')}>拒绝</button></div></div>
}

function DeliverableRow({ deliverable, reviews }: { deliverable: Deliverable; reviews: WorkTaskDetail['reviews'] }) { return <article className="deliverable-row"><div><strong>v{deliverable.version} · {deliverable.title}</strong><span>{deliverable.status}</span></div><p>{deliverable.summary}</p><small>Artifact {deliverable.artifactId.slice(0, 8)}@v{deliverable.artifactVersionId} · {deliverable.evidenceRefs.length} 条证据</small>{reviews.map((review) => <blockquote key={review.id}><strong>{review.decision}</strong>{review.feedback || '验收通过'}</blockquote>)}</article> }
const employeeName = (employees: CyberEmployee[], id: string) => employees.find((employee) => employee.id === id)?.displayName ?? id
const priorityLabel = (priority: WorkTask['priority']) => ({ low: '低', normal: '普通', high: '高', urgent: '紧急' })[priority]
const taskStatusLabel = (status: WorkTask['status']) => ({ draft: '待规划', planning: '规划中', ready: '待执行', running: '进行中', 'waiting-approval': '等待审批', 'waiting-review': '等待验收', 'changes-requested': '要求修改', completed: '已完成', failed: '失败', cancelled: '已取消', 'recovery-required': '需要恢复' })[status]
