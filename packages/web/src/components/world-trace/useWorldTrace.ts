import { useCallback, useEffect, useState } from 'react'

import type { WorldTraceEntry, WorldTracePage } from '@dsh-cyber/contracts'

import { api } from '../../api.js'

export interface UseWorldTraceResult {
  entries: WorldTraceEntry[]
  loading: boolean
  error?: string
  refresh(): Promise<void>
}

export function useWorldTrace(worldId: string, demoMode: boolean): UseWorldTraceResult {
  const [entries, setEntries] = useState<WorldTraceEntry[]>(() => demoMode ? demoTrace(worldId) : [])
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string>()

  const refresh = useCallback(async () => {
    if (demoMode) {
      setEntries(demoTrace(worldId))
      return
    }
    setLoading(true)
    setError(undefined)
    try {
      const result = await api<WorldTracePage>(`/api/worlds/${encodeURIComponent(worldId)}/trace?limit=200`)
      // A live event can arrive while this request is in flight. Merge instead of
      // replacing so an older history response cannot erase that newer fact.
      setEntries((current) => mergeTraceEntries(current, result.items))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界轨迹加载失败')
    } finally {
      setLoading(false)
    }
  }, [demoMode, worldId])

  useEffect(() => {
    setEntries(demoMode ? demoTrace(worldId) : [])
    void refresh()
  }, [demoMode, refresh, worldId])

  useEffect(() => {
    if (demoMode) return
    const stream = new EventSource(`/api/worlds/${encodeURIComponent(worldId)}/live`)
    const onTrace = (raw: Event) => {
      try {
        const entry = JSON.parse((raw as MessageEvent<string>).data) as WorldTraceEntry
        if (entry.worldId !== worldId) return
        setEntries((current) => mergeTraceEntries(current, [entry]))
      } catch {
        // History refresh is authoritative after malformed or interrupted transient data.
      }
    }
    const onReady = () => { void refresh() }
    stream.addEventListener('trace', onTrace)
    stream.addEventListener('ready', onReady)
    return () => {
      stream.removeEventListener('trace', onTrace)
      stream.removeEventListener('ready', onReady)
      stream.close()
    }
  }, [demoMode, refresh, worldId])

  return { entries, loading, ...(error === undefined ? {} : { error }), refresh }
}

export function mergeTraceEntries(
  current: WorldTraceEntry[],
  incoming: WorldTraceEntry[],
): WorldTraceEntry[] {
  const merged = new Map<string, WorldTraceEntry>(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) {
    const existing = merged.get(entry.id)
    if (existing === undefined || existing.updatedAt.localeCompare(entry.updatedAt) <= 0) {
      merged.set(entry.id, existing === undefined ? entry : {
        ...existing,
        ...entry,
        createdAt: existing.createdAt.localeCompare(entry.createdAt) <= 0 ? existing.createdAt : entry.createdAt,
      })
    }
  }
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}

function demoTrace(worldId: string): WorldTraceEntry[] {
  const base = Date.now() - 5 * 60_000
  const entries: Array<Omit<WorldTraceEntry, 'worldId' | 'sourceKind' | 'createdAt' | 'updatedAt'> & { offset: number }> = [
    { id: 'demo-request', category: 'task', status: 'success', summary: '用户提交了新的会话请求', actorId: 'owner', sourceId: 'demo-message', offset: 0 },
    { id: 'demo-turn', category: 'agent', status: 'success', summary: '角色已完成本轮处理', actorId: 'employee-demo', sourceId: 'demo-turn', offset: 35_000 },
    { id: 'demo-tool', category: 'tool', status: 'success', summary: '工具执行完成', detail: '检索世界档案', actorId: 'employee-demo', sourceId: 'demo-tool', offset: 48_000 },
    { id: 'demo-skill', category: 'skill', status: 'success', summary: '灯光控制技能执行成功', actorId: 'employee-demo', skillId: 'world.lights', sourceId: 'demo-skill', offset: 70_000 },
    { id: 'demo-world', category: 'world', status: 'success', summary: '世界灯光已切换', actorId: 'owner', sourceId: 'demo-world', offset: 92_000 },
  ]
  const projected: WorldTraceEntry[] = entries.map(({ offset, ...entry }) => {
    const timestamp = new Date(base + offset).toISOString()
    return { ...entry, worldId, sourceKind: entry.category === 'skill' ? 'skill-action' : 'domain-event', createdAt: timestamp, updatedAt: timestamp }
  })
  return projected.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
}
