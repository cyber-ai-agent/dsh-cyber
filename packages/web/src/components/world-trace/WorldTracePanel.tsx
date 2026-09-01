import { ArrowClockwise, Path } from '@phosphor-icons/react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { World, WorldTraceQuery } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../../types.js'
import { ContextInspectorPanel } from '../context-inspector/ContextInspectorPanel.js'
import { WorldTraceFilters, type TraceFilters } from './WorldTraceFilters.js'
import { WorldTraceTimeline } from './WorldTraceTimeline.js'
import { useWorldTrace } from './useWorldTrace.js'
import { useI18n } from '../../i18n/runtime.js'
import './world-trace.css'

const EMPTY_FILTERS: TraceFilters = { category: '', status: '', actorId: '', date: '', search: '' }

type TraceView = 'trace' | 'context'

export function WorldTracePanel({ world, employees, demoMode, conversationId }: { world: World; employees: CyberEmployee[]; demoMode: boolean; conversationId?: string }) {
  const { locale, t } = useI18n()
  const [view, setView] = useState<TraceView>('trace')
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

  return <section className="world-trace-panel" aria-label={`${world.name} - ${t('workbench.traceTitle', '世界轨迹')}`}>
    <header className="world-trace-panel__header"><span className="world-trace-panel__mark"><Path size={20} /></span><span><strong>{t('workbench.traceTitle', '世界轨迹')}</strong><small>{t('workbench.traceSubtitle', '可读的判断摘要、工具调度与实际用量')}</small></span>{view === 'trace' ? <button type="button" className="icon-button" aria-label={t('workbench.traceRefresh', '刷新世界轨迹')} disabled={trace.loading} onClick={() => void trace.refresh()}><ArrowClockwise size={17} className={trace.loading ? 'spin' : ''} /></button> : null}</header>
    <div className="world-trace-views" role="group" aria-label={t('workbench.traceViews', '轨迹视图')}>
      <button type="button" aria-pressed={view === 'trace'} className={view === 'trace' ? 'is-active' : ''} onClick={() => setView('trace')}>{t('workbench.traceViewTrace', '轨迹')}</button>
      <button type="button" aria-pressed={view === 'context'} className={view === 'context' ? 'is-active' : ''} onClick={() => setView('context')}>{t('workbench.traceViewContext', '上下文')}</button>
    </div>
    {view === 'context'
      ? <ContextInspectorPanel demoMode={demoMode} {...(conversationId === undefined ? {} : { conversationId })} />
      : <>
        <WorldTraceFilters value={filters} employees={employees} onChange={setFilters} />
        {trace.error === undefined ? null : <div className="world-trace-error" role="alert">{trace.error}</div>}
        <div className="world-trace-summary"><strong>{trace.entries.length}</strong><span>{t('workbench.traceCount', '{count} 条轨迹', { count: trace.entries.length })}</span><span className="world-trace-summary__tokens">{totalTokens > 0 ? `${formatTokenCount(totalTokens, locale)} Token` : t('workbench.traceNoTokens', 'Token 暂无返回')}</span><i />{t('workbench.traceLiveUpdate', '实时更新')}</div>
        {tokenByActor.length === 0 ? null : <div className="world-trace-token-strip" aria-label={t('workbench.traceActorStats', '按角色统计 Token')}>
          {tokenByActor.map(([actorId, total]) => <button key={actorId} type="button" className={filters.actorId === actorId ? 'is-active' : ''} onClick={() => setFilters((current) => ({ ...current, actorId: current.actorId === actorId ? '' : actorId }))}><span>{employees.find((employee) => employee.id === actorId)?.displayName ?? t('workbench.traceUnknownActor', '未知角色')}</span><strong>{formatTokenCount(total, locale)}</strong></button>)}
        </div>}
        <WorldTraceTimeline entries={trace.entries} employees={employees} />
        {trace.nextCursor === undefined ? null : <footer className="world-trace-panel__footer"><button type="button" disabled={trace.loadingMore} onClick={() => void trace.loadMore()}>{trace.loadingMore ? t('workbench.traceLoading', '正在加载…') : t('workbench.traceLoadMore', '加载更早轨迹')}</button></footer>}
      </>}
  </section>
}

function formatTokenCount(value: number, locale: string): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : new Intl.NumberFormat(locale).format(value)
}
