import type { WorldTraceEntry, WorldTraceToolStep } from '@dsh-cyber/contracts'

export interface TraceTurnGroup {
  key: string
  /** Defined when entries share one WorkTurn; undefined for standalone facts. */
  workTurnId?: string
  entries: WorldTraceEntry[]
}

/**
 * Fold a newest-first entry list into WorkTurn groups. Entries that carry no
 * turn stay standalone cards, keeping their chronological slot: the first
 * entry seen for a turn fixes the group's position, exactly like a normal
 * timeline row.
 */
export function groupTraceEntriesByTurn(entries: readonly WorldTraceEntry[]): TraceTurnGroup[] {
  const groups: TraceTurnGroup[] = []
  const byTurn = new Map<string, TraceTurnGroup>()
  for (const entry of entries) {
    const turnId = entry.workTurnId
    if (turnId === undefined) {
      groups.push({ key: `solo:${entry.id}`, entries: [entry] })
      continue
    }
    let group = byTurn.get(turnId)
    if (group === undefined) {
      group = { key: `turn:${turnId}`, workTurnId: turnId, entries: [] }
      byTurn.set(turnId, group)
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}

const STATUS_RANK: Record<WorldTraceEntry['status'], number> = {
  failed: 0, running: 1, waiting: 2, pending: 3, cancelled: 4, success: 5, info: 6,
}

export interface TraceTurnSummary {
  actorNames: string[]
  status: WorldTraceEntry['status']
  toolCount: number
  artifactCount: number
  tokenTotal: number
  durationMs: number | undefined
  /** Short human label for the group header. */
  label: string
}

export function summarizeTraceGroup(group: TraceTurnGroup, actorName: (actorId: string | undefined) => string | undefined): TraceTurnSummary {
  const actorIds = [...new Set(group.entries.map((entry) => entry.actorId).filter((id): id is string => id !== undefined && id !== 'owner'))]
  const names = actorIds.map((id) => actorName(id) ?? '未知角色')
  const tools = new Map<string, WorldTraceToolStep>()
  const artifacts = new Set<string>()
  let tokenTotal = 0
  let status: WorldTraceEntry['status'] = 'info'
  for (const entry of group.entries) {
    for (const tool of entry.tools ?? []) tools.set(tool.callId, tool)
    for (const artifact of entry.artifacts ?? []) artifacts.add(`${artifact.artifactId}:${artifact.version}`)
    tokenTotal += entry.tokenUsage?.total ?? 0
    if (STATUS_RANK[entry.status] < STATUS_RANK[status]) status = entry.status
  }
  const start = group.entries.reduce((min, entry) => entry.createdAt < min ? entry.createdAt : min, group.entries[0]!.createdAt)
  const end = group.entries.reduce((max, entry) => entry.updatedAt > max ? entry.updatedAt : max, group.entries[0]!.createdAt)
  const span = Date.parse(end) - Date.parse(start)
  const subject = names.length === 0 ? '世界事件' : names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 名角色`
  return {
    actorNames: names,
    status,
    toolCount: tools.size,
    artifactCount: artifacts.size,
    tokenTotal,
    durationMs: Number.isFinite(span) && span > 0 ? span : undefined,
    label: subject,
  }
}
