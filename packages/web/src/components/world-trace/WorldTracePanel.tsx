import { ArrowClockwise, Path } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { World } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { WorldTraceFilters, type TraceFilters } from './WorldTraceFilters.js'
import { WorldTraceTimeline } from './WorldTraceTimeline.js'
import { useWorldTrace } from './useWorldTrace.js'
import './world-trace.css'

export function WorldTracePanel({ world, employees, demoMode }: { world: World; employees: CyberEmployee[]; demoMode: boolean }) {
  const trace = useWorldTrace(world.id, demoMode)
  const [filters, setFilters] = useState<TraceFilters>({ category: '', status: '', actorId: '' })
  const entries = useMemo(() => trace.entries
    .filter((entry) => !filters.category || entry.category === filters.category)
    .filter((entry) => !filters.status || entry.status === filters.status)
    .filter((entry) => !filters.actorId || entry.actorId === filters.actorId), [filters, trace.entries])

  return <section className="world-trace-panel" aria-label={`${world.name}的世界轨迹`}>
    <header className="world-trace-panel__header"><span className="world-trace-panel__mark"><Path size={20} /></span><span><strong>世界轨迹</strong><small>只展示经过脱敏的真实执行事实</small></span><button type="button" className="icon-button" aria-label="刷新世界轨迹" disabled={trace.loading} onClick={() => void trace.refresh()}><ArrowClockwise size={17} className={trace.loading ? 'spin' : ''} /></button></header>
    <WorldTraceFilters value={filters} employees={employees} onChange={setFilters} />
    {trace.error === undefined ? null : <div className="world-trace-error" role="alert">{trace.error}</div>}
    <div className="world-trace-summary"><strong>{entries.length}</strong><span>条可见轨迹</span><i />实时回补已开启</div>
    <WorldTraceTimeline entries={entries} employees={employees} />
  </section>
}
