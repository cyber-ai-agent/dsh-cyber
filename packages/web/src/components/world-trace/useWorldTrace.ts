import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WorldTraceEntry, WorldTracePage, WorldTraceQuery } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { subscribeWorldLive } from '../../world-live-client.js'

export interface UseWorldTraceResult {
  entries: WorldTraceEntry[]
  loading: boolean
  loadingMore: boolean
  nextCursor?: string
  error?: string
  refresh(): Promise<void>
  loadMore(): Promise<void>
}

export function useWorldTrace(worldId: string, demoMode: boolean, query: WorldTraceQuery = {}): UseWorldTraceResult {
  const queryKey = useMemo(() => JSON.stringify(query), [query])
  const activeQuery = useMemo(() => JSON.parse(queryKey) as WorldTraceQuery, [queryKey])
  const [entries, setEntries] = useState<WorldTraceEntry[]>(() => demoMode ? demoTrace(worldId) : [])
  const [loading, setLoading] = useState(!demoMode)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string>()
  const [error, setError] = useState<string>()
  const requestGeneration = useRef(0)

  const fetchPage = useCallback(async (after?: string) => {
    const params = new URLSearchParams({ limit: '50' })
    for (const [key, value] of Object.entries(activeQuery)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    if (after !== undefined) params.set('after', after)
    return api<WorldTracePage>(`/api/worlds/${encodeURIComponent(worldId)}/trace?${params.toString()}`)
  }, [activeQuery, worldId])

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current
    if (demoMode) {
      setEntries(demoTrace(worldId).filter((entry) => matchesQuery(entry, activeQuery)))
      setNextCursor(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await fetchPage()
      if (generation !== requestGeneration.current) return
      setEntries((current) => mergeTraceEntries(current, result.items))
      setNextCursor(result.nextCursor)
    } catch (cause) {
      if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : '世界轨迹加载失败')
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [activeQuery, demoMode, fetchPage, worldId])

  const loadMore = useCallback(async () => {
    if (demoMode || nextCursor === undefined || loadingMore) return
    const generation = requestGeneration.current
    setLoadingMore(true)
    try {
      const result = await fetchPage(nextCursor)
      if (generation !== requestGeneration.current) return
      setEntries((current) => mergeTraceEntries(current, result.items))
      setNextCursor(result.nextCursor)
    } catch (cause) {
      if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : '更早轨迹加载失败')
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false)
    }
  }, [demoMode, fetchPage, loadingMore, nextCursor])

  useEffect(() => {
    requestGeneration.current += 1
    setEntries([])
    setNextCursor(undefined)
    void refresh()
  }, [queryKey, refresh, worldId])

  useEffect(() => {
    if (demoMode) return
    const onTrace = (raw: Event) => {
      try {
        const entry = JSON.parse((raw as MessageEvent<string>).data) as WorldTraceEntry
        if (entry.worldId !== worldId || !matchesQuery(entry, activeQuery)) return
        setEntries((current) => mergeTraceEntries(current, [entry]))
      } catch {
        // History refresh is authoritative after malformed or interrupted transient data.
      }
    }
    const onReady = () => { void refresh() }
    const unsubscribeTrace = subscribeWorldLive(worldId, 'trace', onTrace)
    const unsubscribeReady = subscribeWorldLive(worldId, 'ready', onReady)
    return () => {
      unsubscribeTrace()
      unsubscribeReady()
    }
  }, [activeQuery, demoMode, refresh, worldId])

  return { entries, loading, loadingMore, ...(nextCursor === undefined ? {} : { nextCursor }), ...(error === undefined ? {} : { error }), refresh, loadMore }
}

export function mergeTraceEntries(current: WorldTraceEntry[], incoming: WorldTraceEntry[]): WorldTraceEntry[] {
  const merged = new Map<string, WorldTraceEntry>(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) {
    const existing = merged.get(entry.id)
    if (existing === undefined || existing.updatedAt.localeCompare(entry.updatedAt) <= 0) {
      const tools = new Map((existing?.tools ?? []).map((tool) => [tool.callId, tool]))
      for (const tool of entry.tools ?? []) tools.set(tool.callId, { ...tools.get(tool.callId), ...tool })
      merged.set(entry.id, existing === undefined ? entry : {
        ...existing,
        ...entry,
        createdAt: existing.createdAt.localeCompare(entry.createdAt) <= 0 ? existing.createdAt : entry.createdAt,
        ...(tools.size === 0 ? {} : { tools: [...tools.values()] }),
      })
    }
  }
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}

function matchesQuery(entry: WorldTraceEntry, query: WorldTraceQuery): boolean {
  if (query.category && entry.category !== query.category) return false
  if (query.status && entry.status !== query.status) return false
  if (query.actorId && entry.actorId !== query.actorId) return false
  if (query.date && localCalendarDate(entry.createdAt) !== query.date) return false
  if (query.search) {
    const search = query.search.toLocaleLowerCase('zh-CN')
    const text = [entry.summary, entry.detail, entry.reasoningSummary, entry.modelId, entry.provider,
      ...(entry.tools ?? []).flatMap((tool) => [tool.label, tool.name])]
      .filter((value): value is string => typeof value === 'string').join('\n').toLocaleLowerCase('zh-CN')
    if (!text.includes(search)) return false
  }
  return true
}

function localCalendarDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function demoTrace(worldId: string): WorldTraceEntry[] {
  const base = Date.now() - 5 * 60_000
  return [
    {
      id: 'demo-run', worldId, category: 'tool', status: 'success', summary: '完成处理，调度了 2 个工具',
      actorId: 'employee-demo', workTurnId: 'demo-turn', sourceKind: 'agent-run', sourceId: 'demo-run',
      reasoningSummary: '先核对世界档案中的目标，再读取相关文件，最后根据两处证据整理结论。',
      tools: [
        { callId: 'demo-read', name: 'read_file', label: '读取信息', status: 'success' },
        { callId: 'demo-search', name: 'web_search', label: '搜索并核对网络信息', status: 'success' },
      ],
      tokenUsage: { prompt: 1_280, completion: 436, total: 1_716 }, durationMs: 4_860,
      modelId: 'deepseek-chat', provider: 'DeepSeek',
      createdAt: new Date(base).toISOString(), updatedAt: new Date(base + 48_000).toISOString(),
    },
  ]
}
