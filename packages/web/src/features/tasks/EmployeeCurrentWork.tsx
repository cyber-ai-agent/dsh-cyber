import { useEffect, useState } from 'react'
import type { WorkTaskDetail } from '@dsh-cyber/contracts'
import { api } from '../../api.js'

export function EmployeeCurrentWork({ employeeId }: { employeeId: string }) {
  const [items, setItems] = useState<WorkTaskDetail[]>([])
  useEffect(() => {
    let active = true
    void api<{ items: WorkTaskDetail[] }>(`/api/employees/${employeeId}/current-work`)
      .then((result) => { if (active) setItems(result.items) })
      .catch(() => { if (active) setItems([]) })
    return () => { active = false }
  }, [employeeId])
  if (items.length === 0) return <section className="dossier-section"><header><h3>当前工作</h3></header><p className="dossier-empty">当前没有进行中的任务。</p></section>
  return <section className="dossier-section"><header><h3>当前工作</h3></header><div className="dossier-current-work">{items.map((detail) => {
    const assignment = detail.assignments.findLast((item) => item.employeeId === employeeId)
    const step = assignment === undefined ? undefined : detail.steps.find((item) => item.id === assignment.stepId)
    const run = detail.runs.at(-1)
    return <article key={detail.task.id}><div><strong>{detail.task.title}</strong><span>{currentStatus(detail.task.status)}</span></div><p>{step?.title ?? '等待生成计划'} · {step?.expectedOutput ?? '预计形成可审阅交付'}</p><small>{run === undefined ? '尚未开始执行' : `开始于 ${new Date(run.startedAt).toLocaleString('zh-CN')} · ${run.agentRunIds.length} 个 AgentRun`}</small></article>
  })}</div></section>
}

function currentStatus(status: WorkTaskDetail['task']['status']): string {
  if (status === 'waiting-approval') return '等待审批'
  if (status === 'waiting-review') return '等待验收'
  if (status === 'changes-requested') return '等待新版本'
  if (status === 'recovery-required') return '需要恢复'
  return '进行中'
}
