import { ArrowClockwise, CaretDown, DownloadSimple, Path } from '@phosphor-icons/react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
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

export function WorldTracePanel({ world, employees, demoMode, conversationId, onOpenArtifact }: {
  world: World
  employees: CyberEmployee[]
  demoMode: boolean
  conversationId?: string
  /** Hands an artifact id back to the host so the Artifact Center opens it. */
  onOpenArtifact?: (artifactId: string) => void
}) {
  const { locale, t } = useI18n()
  const stored = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(`dsh-cyber.trace.${world.id}`) ?? '') as { filters?: TraceFilters; grouped?: boolean } } catch { return {} }
  }, [world.id])
  const [view, setView] = useState<TraceView>('trace')
  // The run whose context the 上下文 view is focused on. Set from a trace
  // card; cleared when the reader picks the tab directly or steps back.
  const [contextRunId, setContextRunId] = useState<string>()
  const [filters, setFilters] = useState<TraceFilters>(stored.filters ?? EMPTY_FILTERS)
  const [grouped, setGrouped] = useState(stored.grouped ?? true)
  const [openKeys, setOpenKeys] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atTopRef = useRef(true)
  const deferredSearch = useDeferredValue(filters.search.trim())
  const query = useMemo<WorldTraceQuery>(() => ({
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.date ? { date: filters.date } : {}),
    ...(deferredSearch ? { search: deferredSearch } : {}),
  }), [deferredSearch, filters.actorId, filters.category, filters.date, filters.status])
  const trace = useWorldTrace(world.id, demoMode, query, atTopRef)

  useEffect(() => {
    try { localStorage.setItem(`dsh-cyber.trace.${world.id}`, JSON.stringify({ filters, grouped })) } catch { /* private mode */ }
  }, [filters, grouped, world.id])

  const toggleExpanded = useCallback((key: string, open: boolean) => {
    setOpenKeys((current) => open ? [...current, key] : current.filter((item) => item !== key))
  }, [])

  const onScroll = useCallback(() => {
    const node = scrollRef.current
    if (node === null) return
    const atTop = node.scrollTop <= 8
    atTopRef.current = atTop
    if (atTop && trace.pendingNew > 0) trace.markSeen()
  }, [trace])

  const jumpToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    atTopRef.current = true
    trace.markSeen()
  }, [trace])

  const exportTrace = useCallback(() => {
    const payload = {
      world: world.name,
      exportedAt: new Date().toISOString(),
      // Entries are the server's already-sanitized read model; nothing raw is
      // reachable here, and export never widens what the panel can show.
      entries: trace.entries,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `世界轨迹-${world.name}-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [trace.entries, world.name])

  const applyPreset = useCallback((preset: 'all' | 'failed' | 'running' | 'tool') => {
    setFilters((current) => preset === 'all' ? { ...EMPTY_FILTERS, search: current.search }
      : preset === 'failed' ? { ...EMPTY_FILTERS, search: current.search, status: 'failed' }
        : preset === 'running' ? { ...EMPTY_FILTERS, search: current.search, status: 'running' }
          : { ...EMPTY_FILTERS, search: current.search, category: 'tool' })
  }, [])

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
      <button type="button" aria-pressed={view === 'trace'} className={view === 'trace' ? 'is-active' : ''} onClick={() => { setContextRunId(undefined); setView('trace') }}>{t('workbench.traceViewTrace', '轨迹')}</button>
      <button type="button" aria-pressed={view === 'context'} className={view === 'context' ? 'is-active' : ''} onClick={() => { setContextRunId(undefined); setView('context') }}>{t('workbench.traceViewContext', '上下文')}</button>
    </div>
    {view === 'context'
      ? <ContextInspectorPanel demoMode={demoMode} {...(conversationId === undefined ? {} : { conversationId })} {...(contextRunId === undefined ? {} : { agentRunId: contextRunId, onClearRun: () => setContextRunId(undefined) })} />
      : <>
        <div className="world-trace-toolbar">
          <div className="world-trace-presets" role="group" aria-label={t('workbench.tracePresets', '快捷筛选')}>
            <button type="button" className={isPresetActive(filters, 'all') ? 'is-active' : ''} onClick={() => applyPreset('all')}>{t('workbench.tracePresetAll', '全部')}</button>
            <button type="button" className={isPresetActive(filters, 'failed') ? 'is-active' : ''} onClick={() => applyPreset('failed')}>{t('workbench.tracePresetFailed', '仅失败')}</button>
            <button type="button" className={isPresetActive(filters, 'running') ? 'is-active' : ''} onClick={() => applyPreset('running')}>{t('workbench.tracePresetRunning', '进行中')}</button>
            <button type="button" className={isPresetActive(filters, 'tool') ? 'is-active' : ''} onClick={() => applyPreset('tool')}>{t('workbench.tracePresetTool', '工具调用')}</button>
          </div>
          <div className="world-trace-toolbar__right">
            <button type="button" className="world-trace-toggle" onClick={exportTrace}><DownloadSimple size={13} />{t('workbench.traceExport', '导出')}</button>
            <button type="button" className="world-trace-toggle" aria-pressed={grouped} onClick={() => setGrouped((current) => !current)}>{grouped ? t('workbench.traceGroupOn', '按回合分组') : t('workbench.traceGroupOff', '平铺全部')}</button>
            <button type="button" className="world-trace-toggle" aria-expanded={showFilters} aria-controls="world-trace-filters" onClick={() => setShowFilters((current) => !current)}>{t('workbench.traceMoreFilters', '更多筛选')}<CaretDown size={13} className={showFilters ? 'is-open' : ''} /></button>
          </div>
        </div>
        {showFilters ? <div id="world-trace-filters"><WorldTraceFilters value={filters} employees={employees} onChange={setFilters} /></div> : null}
        {trace.error === undefined ? null : <div className="world-trace-error" role="alert">{trace.error}</div>}
        <div className="world-trace-summary"><strong>{trace.entries.length}</strong><span>{t('workbench.traceCount', '{count} 条轨迹', { count: trace.entries.length })}</span><span className="world-trace-summary__tokens">{totalTokens > 0 ? `${formatTokenCount(totalTokens, locale)} Token` : t('workbench.traceNoTokens', 'Token 暂无返回')}</span><i />{t('workbench.traceLiveUpdate', '实时更新')}</div>
        {tokenByActor.length === 0 ? null : <div className="world-trace-token-strip" aria-label={t('workbench.traceActorStats', '按角色统计 Token')}>
          {tokenByActor.map(([actorId, total]) => <button key={actorId} type="button" className={filters.actorId === actorId ? 'is-active' : ''} onClick={() => setFilters((current) => ({ ...current, actorId: current.actorId === actorId ? '' : actorId }))}><span>{employees.find((employee) => employee.id === actorId)?.displayName ?? t('workbench.traceUnknownActor', '未知角色')}</span><strong>{formatTokenCount(total, locale)}</strong></button>)}
        </div>}
        <div className="world-trace-scroll-host">
          {trace.loading && trace.entries.length === 0
            ? <div className="world-trace-skeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index} className="world-trace-skeleton__row" />)}</div>
            : <WorldTraceTimeline entries={trace.entries} employees={employees} grouped={grouped} openKeys={openKeys} onToggle={toggleExpanded} scrollRef={scrollRef} onScroll={onScroll} {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })} onOpenContext={(agentRunId) => { setContextRunId(agentRunId); setView('context') }} />}
          {trace.pendingNew > 0 ? <button type="button" className="world-trace-new-pill" onClick={jumpToTop}><span className="world-trace-new-pill__dot" aria-hidden="true" />{t('workbench.traceNewPill', '{count} 条新轨迹', { count: trace.pendingNew })}</button> : null}
        </div>
        {trace.nextCursor === undefined ? null : <footer className="world-trace-panel__footer"><button type="button" disabled={trace.loadingMore} onClick={() => void trace.loadMore()}>{trace.loadingMore ? t('workbench.traceLoading', '正在加载…') : t('workbench.traceLoadMore', '加载更早轨迹')}</button></footer>}
      </>}
  </section>
}

function isPresetActive(filters: TraceFilters, preset: 'all' | 'failed' | 'running' | 'tool'): boolean {
  if (preset === 'all') return !filters.category && !filters.status && !filters.actorId && !filters.date
  if (preset === 'failed') return filters.status === 'failed' && !filters.category
  if (preset === 'running') return filters.status === 'running' && !filters.category
  return filters.category === 'tool' && !filters.status
}

function formatTokenCount(value: number, locale: string): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k` : new Intl.NumberFormat(locale).format(value)
}
