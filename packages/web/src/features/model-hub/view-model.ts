import type { DiscoveredModel, HubProfile, HubProvider } from './api.js'

/**
 * Pure view logic of the model hub: what is selected by default, how a
 * capability verdict reads, and how the pool groups. Kept free of React so
 * the behavior is testable and the component stays presentational.
 */

export function defaultSelection(models: readonly DiscoveredModel[], popular: readonly string[]): Set<string> {
  const known = new Set(models.map((model) => model.id))
  const preferred = popular.filter((id) => known.has(id))
  // Popular ids first; when the catalog entry names none that exist here,
  // fall back to the first page of what the endpoint actually serves.
  if (preferred.length > 0) return new Set(preferred)
  return new Set(models.slice(0, 10).map((model) => model.id))
}

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function selectionModels(models: readonly DiscoveredModel[], selected: ReadonlySet<string>): DiscoveredModel[] {
  return models.filter((model) => selected.has(model.id))
}

export type CapabilityTone = 'good' | 'bad' | 'unknown'

export function capabilityTone(verdict: string | undefined): CapabilityTone {
  switch (verdict) {
    case 'supported': return 'good'
    case 'unsupported': return 'bad'
    default: return 'unknown'
  }
}

export const CAPABILITY_MESSAGE_KEYS = {
  supported: 'modelHub.verdictSupported',
  unsupported: 'modelHub.verdictUnsupported',
  unclear: 'modelHub.verdictUnclear',
  error: 'modelHub.verdictError',
} as const

export function capabilityFallback(verdict: string | undefined): string {
  switch (verdict) {
    case 'supported': return '支持'
    case 'unsupported': return '不支持'
    case 'unclear': return '未证实'
    case 'error': return '探测失败'
    default: return '未检测'
  }
}

export interface PoolGroup {
  provider: HubProvider | undefined
  profiles: HubProfile[]
}

export function groupPool(profiles: readonly HubProfile[], providers: readonly HubProvider[], query: string): PoolGroup[] {
  const needle = query.trim().toLowerCase()
  const matched = needle
    ? profiles.filter((profile) => `${profile.displayName} ${profile.modelId}`.toLowerCase().includes(needle))
    : [...profiles]
  const byProvider = new Map<string | 'unassigned', HubProfile[]>()
  for (const profile of matched) {
    const key = profile.providerId ?? 'unassigned'
    const list = byProvider.get(key)
    if (list === undefined) byProvider.set(key, [profile])
    else list.push(profile)
  }
  const groups: PoolGroup[] = []
  for (const provider of providers) {
    const list = byProvider.get(provider.id)
    if (list !== undefined) groups.push({ provider, profiles: list.sort((a, b) => a.displayName.localeCompare(b.displayName)) })
  }
  const rest = byProvider.get('unassigned')
  if (rest !== undefined) groups.push({ provider: undefined, profiles: rest.sort((a, b) => a.displayName.localeCompare(b.displayName)) })
  return groups
}

export function contextOf(profile: HubProfile): number | undefined {
  const value = profile.settings.contextWindow
  return typeof value === 'number' && value >= 1_024 ? value : undefined
}

export function formatContext(value: number | undefined): string {
  if (value === undefined) return '—'
  return value >= 1_000 ? `${Math.round(value / 1024)}K` : String(value)
}

export interface SyncSummary {
  added: number
  removed: number
  changed: number
  untouched: number
}

export function summarizeSync(outcome: { added: unknown[]; removed: unknown[]; changed: unknown[]; unchanged: number }): SyncSummary {
  return {
    added: outcome.added.length,
    removed: outcome.removed.length,
    changed: outcome.changed.length,
    untouched: Math.max(0, outcome.unchanged - outcome.changed.length),
  }
}

export const IMPORT_CAP = 50
