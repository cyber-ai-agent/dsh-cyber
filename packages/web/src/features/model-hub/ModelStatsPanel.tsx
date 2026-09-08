import { useEffect, useState } from 'react'
import { ArrowsClockwise } from '@phosphor-icons/react'
import type { ModelStatsItem, ModelStatsResponse } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { formatDuration, formatNumber } from '../../i18n/format.js'
import { fetchModelStats, type HubProvider } from './api.js'

type Range = '7d' | '30d' | 'all'
type Resource = { key: string; status: 'loading' } | { key: string; status: 'ready'; data: ModelStatsResponse } | { key: string; status: 'error'; error: string }

export function ModelStatsPanel({ workspaceId, providers }: { workspaceId: string; providers: readonly HubProvider[] }) {
  const { t } = useI18n()
  const [range, setRange] = useState<Range>('7d')
  const [selection, setSelection] = useState<{ workspaceId: string; id: string }>()
  const choices = providers
    .filter((provider) => provider.workspaceId === workspaceId)
    .map((provider) => ({ id: `provider:${provider.id}`, name: provider.name }))
  const providerId = selection?.workspaceId === workspaceId && choices.some((item) => item.id === selection.id)
    ? selection.id : undefined
  const setProviderId = (id: string | undefined) => setSelection(id === undefined ? undefined : { workspaceId, id })
  // Derive the effective filter before fetching; a removed provider or previous
  // workspace must never issue a request with an invisible active selection.
  useEffect(() => { if (selection !== undefined && providerId === undefined) setSelection(undefined) }, [selection, providerId])
  const names = new Map<string, number>()
  for (const item of choices) names.set(item.name, (names.get(item.name) ?? 0) + 1)
  const [refresh, setRefresh] = useState(0)
  const [resource, setResource] = useState<Resource>()
  const key = JSON.stringify([workspaceId, range, providerId, refresh])
  const failureMessage = t('modelHub.statsLoadFailed', '模型统计数据加载失败。')

  // State changes schedule exactly one request. Cleanup rejects late responses,
  // even if a transport ignores abort; key ownership also protects the render
  // between a selection change and the next effect.
  useEffect(() => {
    const controller = new AbortController()
    let current = true
    const to = new Date()
    const from = range === 'all' ? new Date(0) : new Date(to.getTime() - (range === '30d' ? 30 : 7) * 86_400_000)
    setResource({ key, status: 'loading' })
    void fetchModelStats(workspaceId, {
      groupBy: providerId === undefined ? 'all' : 'provider',
      ...(providerId === undefined ? {} : { providerId }),
      from: from.toISOString(), to: to.toISOString(),
    }, controller.signal).then((data) => {
      if (current) setResource({ key, status: 'ready', data })
    }).catch((error: unknown) => {
      if (current) setResource({ key, status: 'error', error: error instanceof Error ? error.message : failureMessage })
    })
    return () => { current = false; controller.abort() }
  }, [workspaceId, range, providerId, key, failureMessage])

  const active = resource?.key === key ? resource : undefined
  const busy = active === undefined || active.status === 'loading'
  const data = active?.status === 'ready' ? active.data : undefined
  const summary = data?.summary
  return <div className="model-hub__body model-hub__stats">
    <div className="model-hub__toolbar">
      <span className="model-hub__hint">{t('modelHub.statsRecordedHint', '按交互日志统计，对话按运行回合计数。仅累加已上报用量；缓存属于输入的一部分。仅列出已配置服务商；无法归属的历史记录仍计入“全部”。')}</span>
      <button type="button" className="icon-button" aria-label={t('modelHub.statsRefresh', '刷新统计')} disabled={busy} onClick={() => setRefresh((n) => n + 1)}><ArrowsClockwise size={15} className={busy ? 'spin' : undefined} /></button>
    </div>
    <div className="model-hub__stats-time" role="group" aria-label={t('modelHub.statsTimeRange', '统计时间范围')}>
      {(['7d', '30d', 'all'] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} className={range === value ? 'is-active' : ''} onClick={() => setRange(value)}>{value === '7d' ? t('modelHub.statsTime7d', '近 7 天') : value === '30d' ? t('modelHub.statsTime30d', '近 30 天') : t('modelHub.statsTimeAll', '全部')}</button>)}
    </div>
    <div className="model-hub__stats-layout">
      <aside className="model-hub__stats-sidebar" aria-label={t('modelHub.statsProviderFilter', '统计服务商')}>
        <button type="button" aria-pressed={providerId === undefined} className={providerId === undefined ? 'is-active' : ''} onClick={() => setProviderId(undefined)}>{t('modelHub.statsGroupAll', '全部')}</button>
        {choices.map((item) => <button key={item.id} type="button" aria-pressed={providerId === item.id} className={providerId === item.id ? 'is-active' : ''} title={item.id} onClick={() => setProviderId(item.id)}>
          <span>{item.name}{(names.get(item.name) ?? 0) > 1 ? ` · ${item.id.slice(-8)}` : ''}</span>
        </button>)}
      </aside>
      <div className="model-hub__stats-main" aria-busy={busy}>
        {busy ? <div className="model-hub__spinner" role="status">{t('modelHub.loading', '加载中…')}</div> : null}
        {active?.status === 'error' ? <div className="model-hub__error" role="alert">{active.error}</div> : null}
        {summary && data ? <>
          <div className="model-hub__stats-overview">
            {[
              [t('modelHub.colTokensSent', '输入'), formatNumber(summary.totalTokensSent)],
              [t('modelHub.colTokensReceived', '输出'), formatNumber(summary.totalTokensReceived)],
              [t('modelHub.statsTotalCached', '缓存命中'), summary.tokensCached === undefined ? '—' : formatNumber(summary.tokensCached)],
              [t('modelHub.statsInteractions', '交互次数'), formatNumber(summary.totalRequests)],
              [t('modelHub.statsTotalToolCalls', '工具调用'), formatNumber(summary.totalToolCalls)],
              [t('modelHub.statsSuccessRate', '成功率'), summary.totalRequests === 0 ? '—' : `${summary.successRate.toFixed(1)}%`],
            ].map(([label, value]) => <div className="model-hub__stat-card" key={label}><strong>{value}</strong><span>{label}</span></div>)}
          </div>
          {data.items.length === 0 ? <div className="model-hub__empty"><strong>{t('modelHub.statsEmpty', '尚无交互记录')}</strong><span>{t('modelHub.statsEmptyHint', '完成一次对话后这里会出现统计。')}</span></div>
            : <div className="model-hub__stats-table-scroll" tabIndex={0} role="region" aria-label={t('modelHub.statsDetails', '统计明细')}>
              <table className="model-hub__table model-hub__stats-table"><thead><tr>
                <th>{providerId === undefined ? t('modelHub.colName', '名称') : t('modelHub.colModelId', '模型 ID')}</th>
                <th>{t('modelHub.colTokensSent', '输入')}</th><th>{t('modelHub.colTokensReceived', '输出')}</th>
                <th>{t('modelHub.statsTotalCached', '缓存命中')}</th><th>{t('modelHub.statsInteractions', '交互次数')}</th>
                <th>{t('modelHub.statsTotalToolCalls', '工具调用')}</th><th>{t('modelHub.colSuccessRate', '成功率')}</th><th>{t('modelHub.colAvgLatency', '平均耗时')}</th>
              </tr></thead><tbody>{data.items.map((item) => <StatsRow key={item.id} item={item} system={providerId === undefined && item.id === ''} />)}</tbody></table>
            </div>}
        </> : null}
      </div>
    </div>
  </div>
}

function StatsRow({ item, system }: { item: ModelStatsItem; system: boolean }) {
  const { t } = useI18n()
  return <tr><td><strong>{system ? t('modelHub.statsSystem', '系统') : item.name ?? item.id}</strong>{item.worldName ? <small>{item.worldName}</small> : null}</td>
    <td>{formatNumber(item.tokensSent)}</td><td>{formatNumber(item.tokensReceived)}</td><td>{item.hasCacheData ? formatNumber(item.tokensCached ?? 0) : '—'}</td>
    <td>{formatNumber(item.requests)}</td><td>{formatNumber(item.toolCalls)}</td><td>{item.requests === 0 ? '—' : `${(item.successCount / item.requests * 100).toFixed(1)}%`}</td><td>{item.avgLatencyMs === undefined ? '—' : formatDuration(item.avgLatencyMs)}</td>
  </tr>
}
