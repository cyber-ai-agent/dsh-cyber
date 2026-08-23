import { CalendarBlank, Pause, Play, Plus, Trash, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentPermissionMode, TaskSchedule } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import './TaskSchedulePanel.css'

interface TaskSchedulePanelProps {
  employees: CyberEmployee[]
  items: TaskSchedule[]
  busy: boolean
  onCreate(input: { employeeId: string; title: string; prompt: string; kind: 'once' | 'interval'; scheduledAt: string; everySeconds?: number; permissionMode: Exclude<AgentPermissionMode, 'danger-full-access'> }): Promise<void>
  onStatus(item: TaskSchedule, status: 'active' | 'paused'): Promise<void>
  onRun(item: TaskSchedule): Promise<void>
  onDelete(item: TaskSchedule): Promise<void>
}

type ScheduleField = 'employeeId' | 'title' | 'prompt' | 'scheduledAt' | 'intervalMinutes'
type ScheduleErrors = Partial<Record<ScheduleField | 'form', string>>

export function TaskSchedulePanel({ employees, items, busy, onCreate, onStatus, onRun, onDelete }: TaskSchedulePanelProps) {
  const [creating, setCreating] = useState(false)
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<'once' | 'interval'>('once')
  const [scheduledAt, setScheduledAt] = useState(defaultTime())
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [permissionMode, setPermissionMode] = useState<'read-only' | 'workspace-write'>('read-only')
  const [errors, setErrors] = useState<ScheduleErrors>({})
  const titleRef = useRef<HTMLInputElement>(null)
  const employeeRef = useRef<HTMLSelectElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const scheduledAtRef = useRef<HTMLInputElement>(null)
  const intervalRef = useRef<HTMLInputElement>(null)
  const activeEmployeeId = employees.some((employee) => employee.id === employeeId) ? employeeId : employees[0]?.id ?? ''
  const sorted = useMemo(() => [...items].sort((left, right) => (left.nextRunAt ?? left.updatedAt).localeCompare(right.nextRunAt ?? right.updatedAt)), [items])

  useEffect(() => {
    if (!creating) return
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [creating])

  const clearError = (field: ScheduleField) => setErrors((current) => {
    if (current[field] === undefined && current.form === undefined) return current
    const next = { ...current }
    delete next[field]
    delete next.form
    return next
  })

  const resetForm = () => {
    setCreating(false)
    setTitle('')
    setPrompt('')
    setKind('once')
    setScheduledAt(defaultTime())
    setIntervalMinutes('60')
    setPermissionMode('read-only')
    setErrors({})
  }

  const submit = async () => {
    const nextErrors = validateScheduleDraft({ employeeId: activeEmployeeId, title, prompt, kind, scheduledAt, intervalMinutes })
    setErrors(nextErrors)
    const firstInvalid = (['employeeId', 'title', 'prompt', 'scheduledAt', 'intervalMinutes'] as const).find((field) => nextErrors[field] !== undefined)
    if (firstInvalid !== undefined) {
      ({ employeeId: employeeRef, title: titleRef, prompt: promptRef, scheduledAt: scheduledAtRef, intervalMinutes: intervalRef })[firstInvalid].current?.focus()
      return
    }

    try {
      const minutes = Number(intervalMinutes)
      await onCreate({
        employeeId: activeEmployeeId,
        title: title.trim(),
        prompt: prompt.trim(),
        kind,
        scheduledAt: new Date(scheduledAt).toISOString(),
        ...(kind === 'interval' ? { everySeconds: minutes * 60 } : {}),
        permissionMode,
      })
      resetForm()
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : '日程保存失败，请稍后重试。' })
    }
  }

  return <section className="task-schedule-panel" aria-label="任务日程">
    <header>
      <span className="task-schedule-panel__mark"><CalendarBlank size={20}/></span>
      <span><strong>任务日程</strong><small>让指定角色在约定时间执行任务，服务重启后仍会保留</small></span>
      <button type="button" className={creating ? 'text-button' : 'primary-button'} aria-expanded={creating} aria-controls="task-schedule-form" onClick={() => creating ? resetForm() : setCreating(true)}>
        {creating ? <X size={15}/> : <Plus size={15}/>}{creating ? '取消新建' : '新建日程'}
      </button>
    </header>
    {creating ? <form id="task-schedule-form" noValidate aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {errors.form === undefined ? null : <p className="task-schedule-panel__form-error is-wide" role="alert">{errors.form}</p>}
      <label>执行角色
        <select ref={employeeRef} value={activeEmployeeId} aria-invalid={errors.employeeId !== undefined} onChange={(event) => { setEmployeeId(event.target.value); clearError('employeeId') }}>
          {employees.length === 0 ? <option value="">暂无可用角色</option> : employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.displayName} · {employee.role}</option>)}
        </select>
        {errors.employeeId === undefined ? null : <span className="field-error">{errors.employeeId}</span>}
      </label>
      <label>日程名称
        <input ref={titleRef} value={title} maxLength={120} aria-invalid={errors.title !== undefined} onChange={(event) => { setTitle(event.target.value); clearError('title') }} placeholder="例如：每日整理项目进展"/>
        {errors.title === undefined ? null : <span className="field-error">{errors.title}</span>}
      </label>
      <label className="is-wide">任务内容
        <textarea ref={promptRef} rows={4} value={prompt} maxLength={8000} aria-invalid={errors.prompt !== undefined} onChange={(event) => { setPrompt(event.target.value); clearError('prompt') }} placeholder="写清目标、需要使用的资料和交付标准"/>
        {errors.prompt === undefined ? null : <span className="field-error">{errors.prompt}</span>}
      </label>
      <fieldset className="schedule-choice-field">
        <legend>执行方式</legend>
        <div className="schedule-choice">
          <label className={kind === 'once' ? 'is-selected' : ''}><input type="radio" name="schedule-kind" value="once" checked={kind === 'once'} onChange={() => setKind('once')}/><span><strong>单次</strong><small>只在指定时间运行一次</small></span></label>
          <label className={kind === 'interval' ? 'is-selected' : ''}><input type="radio" name="schedule-kind" value="interval" checked={kind === 'interval'} onChange={() => setKind('interval')}/><span><strong>重复</strong><small>按固定间隔持续运行</small></span></label>
        </div>
      </fieldset>
      <label>首次执行
        <input ref={scheduledAtRef} type="datetime-local" value={scheduledAt} aria-invalid={errors.scheduledAt !== undefined} onChange={(event) => { setScheduledAt(event.target.value); clearError('scheduledAt') }}/>
        {errors.scheduledAt === undefined ? null : <span className="field-error">{errors.scheduledAt}</span>}
      </label>
      {kind === 'interval' ? <label>重复间隔（分钟）
        <input ref={intervalRef} type="number" inputMode="numeric" min="5" step="5" value={intervalMinutes} aria-invalid={errors.intervalMinutes !== undefined} onChange={(event) => { setIntervalMinutes(event.target.value); clearError('intervalMinutes') }}/>
        {errors.intervalMinutes === undefined ? <span className="field-help">最短 5 分钟</span> : <span className="field-error">{errors.intervalMinutes}</span>}
      </label> : null}
      <fieldset className="schedule-choice-field">
        <legend>任务权限</legend>
        <div className="schedule-choice">
          <label className={permissionMode === 'read-only' ? 'is-selected' : ''}><input type="radio" name="schedule-permission" value="read-only" checked={permissionMode === 'read-only'} onChange={() => setPermissionMode('read-only')}/><span><strong>只读</strong><small>查看资料，不修改文件</small></span></label>
          <label className={permissionMode === 'workspace-write' ? 'is-selected' : ''}><input type="radio" name="schedule-permission" value="workspace-write" checked={permissionMode === 'workspace-write'} onChange={() => setPermissionMode('workspace-write')}/><span><strong>世界内读写</strong><small>可修改当前世界目录</small></span></label>
        </div>
      </fieldset>
      <p className="task-schedule-panel__guard">无人值守日程不开放“完整访问”，避免在没有人在场确认时修改当前世界目录之外的文件。</p>
      <div className="task-schedule-panel__form-actions"><button type="button" className="text-button" disabled={busy} onClick={resetForm}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存日程'}</button></div>
    </form> : null}
    {sorted.length === 0 && !creating ? <div className="task-schedule-panel__empty"><CalendarBlank size={30}/><strong>还没有任务日程</strong><p>新建后可查看下次执行时间、最近执行时间和当前状态。</p><button type="button" className="primary-button" onClick={() => setCreating(true)}><Plus size={15}/>新建日程</button></div> : <ol>{sorted.map((item) => {
      const employee = employees.find((value) => value.id === item.employeeId)
      const nextStatus = item.status === 'paused' ? 'active' : 'paused'
      return <li key={item.id}>
        <div><span className={`schedule-state is-${item.status}`}>{statusLabel(item.status)}</span><strong>{item.title}</strong><small>{employee?.displayName ?? '角色已不可用'} · {item.kind === 'once' ? '单次' : `每 ${Math.round((item.everySeconds ?? 300) / 60)} 分钟`}</small></div>
        <p>{item.prompt}</p>
        <dl><div><dt>下次执行</dt><dd>{item.nextRunAt ? formatTime(item.nextRunAt) : '无'}</dd></div><div><dt>最近执行</dt><dd>{item.lastRunAt ? formatTime(item.lastRunAt) : '尚未执行'}</dd></div><div><dt>权限</dt><dd>{item.permissionMode === 'read-only' ? '只读' : '世界内读写'}</dd></div></dl>
        <footer>
          <button type="button" disabled={busy || item.status === 'completed'} aria-label={`${item.title}：${nextStatus === 'active' ? '恢复日程' : '暂停日程'}`} onClick={() => void onStatus(item, nextStatus)}>{item.status === 'paused' ? <Play size={14}/> : <Pause size={14}/>} {item.status === 'paused' ? '恢复' : '暂停'}</button>
          <button type="button" disabled={busy} onClick={() => void onRun(item)}><Play size={14}/>立即运行</button>
          <button type="button" className="is-danger" disabled={busy} onClick={() => { if (window.confirm(`删除日程“${item.title}”？`)) void onDelete(item) }}><Trash size={14}/>删除</button>
        </footer>
      </li>
    })}</ol>}
  </section>
}

export function validateScheduleDraft(input: { employeeId: string; title: string; prompt: string; kind: 'once' | 'interval'; scheduledAt: string; intervalMinutes: string }): ScheduleErrors {
  const errors: ScheduleErrors = {}
  if (!input.employeeId) errors.employeeId = '请先选择一个执行角色。'
  if (!input.title.trim()) errors.title = '请填写便于识别的日程名称。'
  if (!input.prompt.trim()) errors.prompt = '请说明要执行的任务内容。'
  const scheduledDate = new Date(input.scheduledAt)
  if (!input.scheduledAt || Number.isNaN(scheduledDate.valueOf())) errors.scheduledAt = '请选择有效的首次执行时间。'
  else if (scheduledDate.valueOf() < Date.now() - 60_000) errors.scheduledAt = '首次执行时间不能早于当前时间。'
  if (input.kind === 'interval') {
    const minutes = Number(input.intervalMinutes)
    if (!Number.isInteger(minutes) || minutes < 5) errors.intervalMinutes = '重复间隔必须是至少 5 分钟的整数。'
  }
  return errors
}

function defaultTime(): string { const date = new Date(Date.now() + 10 * 60_000); date.setSeconds(0, 0); return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
function formatTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function statusLabel(value: TaskSchedule['status']): string { return value === 'active' ? '已启用' : value === 'paused' ? '已暂停' : '已完成' }
