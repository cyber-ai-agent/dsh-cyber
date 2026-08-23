import { useEffect, useRef, useState } from 'react'
import type { WorldTraceEntry } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { WorldTraceItem } from './WorldTraceItem.js'

export function WorldTraceTimeline({ entries, employees }: { entries: WorldTraceEntry[]; employees: CyberEmployee[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousRevision = useRef('')
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    const revision = entries.map((entry) => `${entry.id}:${entry.updatedAt}`).join('|')
    if (revision === previousRevision.current) return
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80
    if (nearBottom || previousRevision.current === '') {
      requestAnimationFrame(() => { container.scrollTop = container.scrollHeight })
      setUnread(0)
    } else {
      setUnread((count) => count + 1)
    }
    previousRevision.current = revision
  }, [entries])

  const jumpToLatest = () => {
    const container = scrollRef.current
    if (container !== null) container.scrollTop = container.scrollHeight
    setUnread(0)
  }

  return <div className="world-trace-timeline-wrap">
    <div ref={scrollRef} className="world-trace-timeline" onScroll={(event) => {
      const element = event.currentTarget
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) setUnread(0)
    }}>
      {entries.length === 0 ? <div className="world-trace-empty"><strong>还没有可展示的轨迹</strong><span>提交真实任务、执行技能或与世界互动后，这里会出现经过脱敏的事实记录。</span></div> : <ol>{entries.map((entry) => <WorldTraceItem key={entry.id} entry={entry} employees={employees} />)}</ol>}
    </div>
    {unread > 0 ? <button className="world-trace-unread" type="button" onClick={jumpToLatest}>{unread} 条新轨迹 · 查看最新</button> : null}
  </div>
}
