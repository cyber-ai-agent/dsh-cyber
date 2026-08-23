import { CalendarBlank, Pause, Play, Plus, Trash } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
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

export function TaskSchedulePanel({ employees, items, busy, onCreate, onStatus, onRun, onDelete }: TaskSchedulePanelProps) {
  const [creating, setCreating] = useState(false)
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<'once' | 'interval'>('once')
  const [scheduledAt, setScheduledAt] = useState(defaultTime())
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [permissionMode, setPermissionMode] = useState<'read-only' | 'workspace-write'>('read-only')
  const activeEmployeeId = employees.some((employee) => employee.id === employeeId) ? employeeId : employees[0]?.id ?? ''
  const sorted = useMemo(() => [...items].sort((left, right) => (left.nextRunAt ?? left.updatedAt).localeCompare(right.nextRunAt ?? right.updatedAt)), [items])

  const submit = async () => {
    await onCreate({ employeeId: activeEmployeeId, title, prompt, kind, scheduledAt: new Date(scheduledAt).toISOString(), ...(kind === 'interval' ? { everySeconds: intervalMinutes * 60 } : {}), permissionMode })
    setCreating(false); setTitle(''); setPrompt(''); setScheduledAt(defaultTime())
  }

  return <section className="task-schedule-panel" aria-label="计划任务">
    <header><span className="task-schedule-panel__mark"><CalendarBlank size={20}/></span><span><strong>计划任务</strong><small>到点后由指定角色真实执行，服务重启后仍保留</small></span><button type="button" className="primary-button" onClick={()=>setCreating((value)=>!value)}><Plus size={15}/>{creating?'收起':'新建计划'}</button></header>
    {creating ? <form onSubmit={(event)=>{event.preventDefault();void submit()}}>
      <label>执行角色<select value={activeEmployeeId} onChange={(event)=>setEmployeeId(event.target.value)}>{employees.map((employee)=><option key={employee.id} value={employee.id}>{employee.displayName} · {employee.role}</option>)}</select></label>
      <label>计划名称<input value={title} maxLength={120} onChange={(event)=>setTitle(event.target.value)} placeholder="例如：每日整理项目进展"/></label>
      <label className="is-wide">任务内容<textarea rows={4} value={prompt} maxLength={8000} onChange={(event)=>setPrompt(event.target.value)} placeholder="写清目标、输入和交付标准"/></label>
      <label>执行方式<select value={kind} onChange={(event)=>setKind(event.target.value as 'once'|'interval')}><option value="once">单次执行</option><option value="interval">按间隔重复</option></select></label>
      <label>首次执行<input type="datetime-local" value={scheduledAt} onChange={(event)=>setScheduledAt(event.target.value)}/></label>
      {kind==='interval'?<label>重复间隔（分钟）<input type="number" min="5" step="5" value={intervalMinutes} onChange={(event)=>setIntervalMinutes(Math.max(5,Number(event.target.value)))}/></label>:null}
      <label>任务权限<select value={permissionMode} onChange={(event)=>setPermissionMode(event.target.value as 'read-only'|'workspace-write')}><option value="read-only">只读</option><option value="workspace-write">当前世界读写</option></select></label>
      <p className="task-schedule-panel__guard">无人值守计划不允许“完整访问”，避免在没有人在场确认时修改世界目录之外的文件。</p>
      <div className="task-schedule-panel__form-actions"><button type="button" className="text-button" onClick={()=>setCreating(false)}>取消</button><button type="submit" className="primary-button" disabled={busy||!activeEmployeeId||!title.trim()||!prompt.trim()}>保存计划</button></div>
    </form>:null}
    {sorted.length===0&&!creating?<div className="task-schedule-panel__empty"><CalendarBlank size={30}/><strong>还没有计划任务</strong><p>新建后会显示下次执行时间、最近结果和运行状态。</p></div>:<ol>{sorted.map((item)=>{const employee=employees.find((value)=>value.id===item.employeeId);return <li key={item.id}>
      <div><span className={`schedule-state is-${item.status}`}>{statusLabel(item.status)}</span><strong>{item.title}</strong><small>{employee?.displayName??'角色已不可用'} · {item.kind==='once'?'单次':`每 ${Math.round((item.everySeconds??300)/60)} 分钟`}</small></div>
      <p>{item.prompt}</p>
      <dl><div><dt>下次执行</dt><dd>{item.nextRunAt?formatTime(item.nextRunAt):'无'}</dd></div><div><dt>最近执行</dt><dd>{item.lastRunAt?formatTime(item.lastRunAt):'尚未执行'}</dd></div><div><dt>权限</dt><dd>{item.permissionMode==='read-only'?'只读':'当前世界读写'}</dd></div></dl>
      <footer><button type="button" disabled={busy||item.status==='completed'} onClick={()=>void onStatus(item,item.status==='paused'?'active':'paused')}>{item.status==='paused'?<Play size={14}/>:<Pause size={14}/>}</button><button type="button" disabled={busy} onClick={()=>void onRun(item)}><Play size={14}/>立即运行</button><button type="button" className="is-danger" disabled={busy} onClick={()=>{if(window.confirm(`删除计划“${item.title}”？`))void onDelete(item)}}><Trash size={14}/><span className="sr-only">删除</span></button></footer>
    </li>})}</ol>}
  </section>
}

function defaultTime(): string { const date=new Date(Date.now()+10*60_000); date.setSeconds(0,0); return new Date(date.valueOf()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16) }
function formatTime(value:string):string{return new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function statusLabel(value:TaskSchedule['status']):string{return value==='active'?'已启用':value==='paused'?'已暂停':'已完成'}
