import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Clock,
  GearSix,
  GlobeHemisphereWest,
  Robot,
  Sparkle,
  UsersThree,
  WarningCircle,
  Wrench,
} from '@phosphor-icons/react'
import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'

const categoryLabel: Record<WorldTraceEntry['category'], string> = {
  agent: '角色', tool: '工具', skill: '技能', task: '任务', collaboration: '协作', world: '世界', schedule: '计划', system: '系统',
}

const statusLabel: Record<WorldTraceEntry['status'], string> = {
  pending: '待处理', running: '进行中', waiting: '等待中', success: '已完成', failed: '失败', cancelled: '已取消', info: '记录',
}

export function WorldTraceItem({ entry, employees }: { entry: WorldTraceEntry; employees: CyberEmployee[] }) {
  const Icon = categoryIcon(entry.category)
  const actor = entry.actorId === 'owner' ? '你' : employees.find((employee) => employee.id === entry.actorId)?.displayName
  return <li className={`world-trace-item world-trace-item--${entry.status}`}>
    <span className="world-trace-item__rail" aria-hidden="true" />
    <span className="world-trace-item__icon" aria-hidden="true"><Icon size={17} /></span>
    <article>
      <header><span>{categoryLabel[entry.category]}</span><time dateTime={entry.updatedAt}>{formatTraceTime(entry.updatedAt)}</time></header>
      <strong>{entry.summary}</strong>
      <div className="world-trace-item__meta"><span className={`trace-status trace-status--${entry.status}`}>{statusIcon(entry.status)}{statusLabel[entry.status]}</span>{actor === undefined ? null : <span>{actor}</span>}</div>
      {entry.detail === undefined ? null : <details><summary>查看详情</summary><p>{entry.detail}</p></details>}
    </article>
  </li>
}

function categoryIcon(category: WorldTraceEntry['category']) {
  return ({ agent: Robot, tool: Wrench, skill: Sparkle, task: CheckCircle, collaboration: UsersThree, world: GlobeHemisphereWest, schedule: Clock, system: GearSix })[category]
}

function statusIcon(status: WorldTraceEntry['status']) {
  if (status === 'running') return <CircleNotch size={12} className="spin" />
  if (status === 'failed') return <WarningCircle size={12} />
  if (status === 'waiting' || status === 'pending') return <Clock size={12} />
  if (status === 'success') return <CheckCircle size={12} weight="fill" />
  return <ArrowsClockwise size={12} />
}

function formatTraceTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '时间未知'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
