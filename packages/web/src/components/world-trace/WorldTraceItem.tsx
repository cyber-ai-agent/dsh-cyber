import {
  ArrowsClockwise, CaretDown, CheckCircle, CircleNotch, Clock, GearSix,
  GlobeHemisphereWest, Robot, Sparkle, UsersThree, WarningCircle, Wrench,
} from '@phosphor-icons/react'
import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'

const categoryLabel: Record<WorldTraceEntry['category'], string> = {
  agent: '角色运行', tool: '角色运行', skill: '技能', task: '任务', collaboration: '协作', world: '世界', schedule: '日程', system: '系统',
}
const statusLabel: Record<WorldTraceEntry['status'], string> = {
  pending: '待处理', running: '进行中', waiting: '等待中', success: '已完成', failed: '失败', cancelled: '已取消', info: '记录',
}

export function WorldTraceItem({ entry, employees }: { entry: WorldTraceEntry; employees: CyberEmployee[] }) {
  const Icon = categoryIcon(entry.category)
  const actor = employees.find((employee) => employee.id === entry.actorId)?.displayName
  const hasDetails = Boolean(entry.reasoningSummary || entry.detail || entry.tools?.length)
  const content = <>
    <header><span>{categoryLabel[entry.category]}</span><time dateTime={entry.updatedAt}>{formatTraceTime(entry.updatedAt)}</time></header>
    <strong>{entry.summary}</strong>
    <div className="world-trace-item__meta"><span className={`trace-status trace-status--${entry.status}`}>{statusIcon(entry.status)}{statusLabel[entry.status]}</span>{actor === undefined ? null : <span>{actor}</span>}{entry.durationMs === undefined ? null : <span>{formatDuration(entry.durationMs)}</span>}{entry.tokenUsage === undefined ? null : <span>{entry.tokenUsage.total.toLocaleString('zh-CN')} Token</span>}</div>
  </>
  return <li className={`world-trace-item world-trace-item--${entry.status}`}>
    <span className="world-trace-item__rail" aria-hidden="true" />
    <span className="world-trace-item__icon" aria-hidden="true"><Icon size={17} /></span>
    {!hasDetails ? <article>{content}</article> : <article className="world-trace-item__expandable"><details><summary><div className="world-trace-item__summary">{content}</div><span className="world-trace-item__expand-label">查看过程<CaretDown size={14} /></span></summary><div className="world-trace-item__detail">
      {entry.reasoningSummary ? <section><strong>判断摘要</strong><p>{entry.reasoningSummary}</p></section> : null}
      {entry.tools?.length ? <section><strong>工具调度</strong><ol className="world-trace-tools">{entry.tools.map((tool) => <li key={tool.callId} className={`is-${tool.status}`}>{tool.status === 'running' ? <CircleNotch size={14} className="spin" /> : tool.status === 'failed' ? <WarningCircle size={14} /> : <CheckCircle size={14} weight="fill" />}<span>{tool.label}</span><small>{tool.status === 'running' ? '执行中' : tool.status === 'failed' ? '失败' : '完成'}</small></li>)}</ol></section> : null}
      {entry.detail ? <section><strong>运行说明</strong><p>{entry.detail}</p></section> : null}
      {entry.modelId || entry.provider || entry.tokenUsage ? <section className="world-trace-usage"><strong>模型用量</strong><dl>{entry.provider ? <><dt>服务</dt><dd>{entry.provider}</dd></> : null}{entry.modelId ? <><dt>模型</dt><dd>{entry.modelId}</dd></> : null}{entry.tokenUsage ? <><dt>输入</dt><dd>{entry.tokenUsage.prompt.toLocaleString('zh-CN')}</dd><dt>输出</dt><dd>{entry.tokenUsage.completion.toLocaleString('zh-CN')}</dd><dt>合计</dt><dd>{entry.tokenUsage.total.toLocaleString('zh-CN')} Token</dd></> : null}</dl></section> : null}
    </div></details></article>}
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
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${value} 毫秒` : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`
}
