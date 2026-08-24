import { ArrowClockwise, Path } from '@phosphor-icons/react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { World, WorldTraceQuery } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { WorldTraceFilters, type TraceFilters } from './WorldTraceFilters.js'
import { WorldTraceTimeline } from './WorldTraceTimeline.js'
import { useWorldTrace } from './useWorldTrace.js'
import './world-trace.css'

const EMPTY_FILTERS: TraceFilters = { category: '', status: '', actorId: '', date: '', search: '' }

export function WorldTracePanel({ world, employees, demoMode }: { world: World; employees: CyberEmployee[]; demoMode: boolean }) {
  const [filters, setFilters] = useState<TraceFilters>(EMPTY_FILTERS)
  const deferredSearch = useDeferredValue(filters.search.trim())
  const query = useMemo<WorldTraceQuery>(() => ({
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.date ? { date: filters.date } : {}),
    ...(deferredSearch ? { search: deferredSearch } : {}),
  }), [deferredSearch, filters.actorId, filters.category, filters.date, filters.status])
  const trace = useWorldTrace(world.id, demoMode, query)
  const tokenByActor = useMemo(() => {
    const totals = new Map<string, number>()
    for (const entry of trace.entries) {
      if (entry.actorId && entry.tokenUsage) totals.set(entry.actorId, (totals.get(entry.actorId) ?? 0) + entry.tokenUsage.total)
    }
    return [...totals.entries()].sort((left, right) => right[1] - left[1])
  }, [trace.entries])
  const totalTokens = tokenByActor.reduce((total, [, count]) => total + count, 0)

  return <section className="world-trace-panel" aria-label={`${world.name}的世界轨迹`}>
    <header className="world-trace-panel__header"><span className="world-trace-panel__mark"><Path size={20} /></span><span><strong>世界轨迹</strong><small>可读的判断摘要、工具调度与实际用量</small></span><button type="button" className="icon-button" aria-label="刷新世界轨迹" disabled={trace.loading} onClick={() => void trace.refresh()}><ArrowClockwise size={17} className={trace.loading ? 'spin' : ''} /></button></header>
    <WorldTraceFilters value={filters} employees={employees} onChange={setFilters} />
    {trace.error === undefined ? null : <div className="world-trace-error" role="alert">{trace.error}</div>}
    <div className="world-trace-summary"><strong>{trace.entries.length}</strong><span>条轨迹</span><span className="world-trace-summary__tokens">{totalTokens > 0 ? `${formatTokenCount(totalTokens)} Token` : 'Token 暂无返回'}</span><i />实时更新</div>
    {tokenByActor.length === 0 ? null : <div className="world-trace-token-strip" aria-label="按角色统计 Token">
      {tokenByActor.map(([actorId, total]) => <button key={actorId} type="button" className={filters.actorId === actorId ? 'is-active' : ''} onClick={() => setFilters((current) => ({ ...current, actorId: current.actorId === actorId ? '' : actorId }))}><span>{employees.find((employee) => employee.id === actorId)?.displayName ?? '未知角色'}</span><strong>{formatTokenCount(total)}</strong></button>)}
    </div>}
    <WorldTraceTimeline entries={trace.entries} employees={employees} />
    {trace.nextCursor === undefined ? null : <footer className="world-trace-panel__footer"><button type="button" disabled={trace.loadingMore} onClick={() => void trace.loadMore()}>{trace.loadingMore ? '正在加载…' : '加载更早轨迹'}</button></footer>}
  </section>
}

function formatTokenCount(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : value.toLocaleString('zh-CN')
}
