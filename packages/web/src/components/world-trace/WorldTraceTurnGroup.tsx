import { CaretDown, CircleNotch, WarningCircle, CheckCircle, Clock, ArrowsClockwise } from '@phosphor-icons/react'
import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { formatDateTime, formatDuration, formatNumber } from '../../i18n/format.js'
import { WorldTraceItem } from './WorldTraceItem.js'
import { summarizeTraceGroup, type TraceTurnGroup } from './groupTraceTurns.js'

const groupStatusIcon = (status: WorldTraceEntry['status']) => {
  if (status === 'running') return <CircleNotch size={14} className="spin" />
  if (status === 'failed') return <WarningCircle size={14} />
  if (status === 'waiting' || status === 'pending') return <Clock size={14} />
  if (status === 'success') return <CheckCircle size={14} weight="fill" />
  return <ArrowsClockwise size={14} />
}

/**
 * One WorkTurn folded into a single card: who answered, how many tools and
 * artifacts the round produced, what it cost — with the individual facts
 * inside. The request text itself never enters the trace; only its summary.
 */
export function WorldTraceTurnGroupCard({ group, employees, open, openKeys, onToggle, onOpenArtifact, onOpenContext }: {
  group: TraceTurnGroup
  employees: CyberEmployee[]
  open: boolean
  openKeys: ReadonlySet<string>
  onToggle: (key: string, open: boolean) => void
  onOpenArtifact?: (artifactId: string) => void
  onOpenContext?: (agentRunId: string) => void
}) {
  const summary = summarizeTraceGroup(group, (actorId) => employees.find((employee) => employee.id === actorId)?.displayName)
  const newest = group.entries.reduce((max, entry) => entry.createdAt > max ? entry.createdAt : max, group.entries[0]!.createdAt)
  const facts: string[] = []
  if (group.entries.length > 1) facts.push(`${group.entries.length} 条事实`)
  if (summary.toolCount > 0) facts.push(`${summary.toolCount} 个工具`)
  if (summary.artifactCount > 0) facts.push(`${summary.artifactCount} 个产物`)
  if (summary.durationMs !== undefined) facts.push(formatDuration(summary.durationMs))
  if (summary.tokenTotal > 0) facts.push(`${formatNumber(summary.tokenTotal)} Token`)
  return <li className={`world-trace-turn trace-status--${summary.status}`}>
    <details open={open} onToggle={(event) => onToggle(group.key, event.currentTarget.open)}>
      <summary>
        <div className="world-trace-turn__head">
          <span className="world-trace-turn__icon" aria-hidden="true">{groupStatusIcon(summary.status)}</span>
          <span className="world-trace-turn__main">
            <strong>{summary.label}</strong>
            <small>{facts.join(' · ') || '1 条事实'}</small>
          </span>
          <time className="world-trace-turn__time" dateTime={newest}>{formatDateTime(newest, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
          <span className="world-trace-turn__caret" aria-hidden="true"><CaretDown size={14} /></span>
        </div>
      </summary>
      <ol className="world-trace-turn__body">
        {group.entries.map((entry) => <WorldTraceItem key={entry.id} entry={entry} employees={employees} open={openKeys.has(`item:${entry.id}`)} onToggle={(next) => onToggle(`item:${entry.id}`, next)} {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })} {...(onOpenContext === undefined ? {} : { onOpenContext })} />)}
      </ol>
    </details>
  </li>
}
