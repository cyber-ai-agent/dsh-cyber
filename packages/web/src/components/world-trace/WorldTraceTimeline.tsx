import type { Ref } from 'react'
import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { groupTraceEntriesByTurn } from './groupTraceTurns.js'
import { WorldTraceItem } from './WorldTraceItem.js'
import { WorldTraceTurnGroupCard } from './WorldTraceTurnGroup.js'

export function WorldTraceTimeline({ entries, employees, grouped = false, openKeys = [], onToggle, onOpenArtifact, onOpenContext, scrollRef, onScroll }: {
  entries: WorldTraceEntry[]
  employees: CyberEmployee[]
  /** Fold entries sharing a WorkTurn into one turn card. */
  grouped?: boolean
  openKeys?: readonly string[]
  onToggle?: (key: string, open: boolean) => void
  onOpenArtifact?: (artifactId: string) => void
  /** Hands a run id back to the host so the Context Inspector opens on that run. */
  onOpenContext?: (agentRunId: string) => void
  scrollRef?: Ref<HTMLDivElement>
  onScroll?: (atTop: boolean) => void
}) {
  const open = new Set(openKeys)
  const toggle = (key: string, next: boolean): void => onToggle?.(key, next)
  const passThrough = {
    ...(onOpenArtifact === undefined ? {} : { onOpenArtifact }),
    ...(onOpenContext === undefined ? {} : { onOpenContext }),
  }
  let body
  if (entries.length === 0) {
    body = <div className="world-trace-empty"><strong>还没有可展示的轨迹</strong><span>提交真实任务、执行技能或与世界互动后，这里会出现经过脱敏的事实记录。</span></div>
  } else if (!grouped) {
    body = <ol>{entries.map((entry) => <WorldTraceItem key={entry.id} entry={entry} employees={employees} open={open.has(`item:${entry.id}`)} onToggle={(next) => toggle(`item:${entry.id}`, next)} {...passThrough} />)}</ol>
  } else {
    body = <ol>{groupTraceEntriesByTurn(entries).map((group) => {
      const [entry] = group.entries
      if (group.workTurnId === undefined || entry === undefined) {
        return entry === undefined ? null : <WorldTraceItem key={entry.id} entry={entry} employees={employees} open={open.has(`item:${entry.id}`)} onToggle={(next) => toggle(`item:${entry.id}`, next)} {...passThrough} />
      }
      return <WorldTraceTurnGroupCard key={group.key} group={group} employees={employees} open={open.has(group.key)} openKeys={open} onToggle={toggle} {...passThrough} />
    })}</ol>
  }
  return <div className="world-trace-timeline-wrap" ref={scrollRef} onScroll={onScroll === undefined ? undefined : (event) => onScroll(event.currentTarget.scrollTop <= 8)}>
    <div className="world-trace-timeline" aria-live="polite">{body}</div>
  </div>
}
