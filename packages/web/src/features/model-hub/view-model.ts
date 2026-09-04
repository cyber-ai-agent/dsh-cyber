import type { DiscoveredModel, HubProfile, HubProvider } from './api.js'

/**
 * Pure view logic of the model hub: what is selected by default, how the pool
 * filters, and what a profile declares. Kept free of React and of display
 * copy so the behavior is testable and the component stays presentational.
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

/**
 * The import list's search box: filtering changes only what is shown. The
 * selection is a separate set, so boxes ticked under one query survive every
 * later query and the clearing of the search — exactly how it must behave
 * when an aggregator serves hundreds of models.
 */
export function searchModels(models: readonly DiscoveredModel[], query: string): DiscoveredModel[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return [...models]
  return models.filter((model) => `${model.displayName ?? ''} ${model.id}`.toLocaleLowerCase().includes(needle))
}

export function mergeSelection(selected: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  const next = new Set(selected)
  for (const id of ids) next.add(id)
  return next
}

export function unmergeSelection(selected: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  const drop = new Set(ids)
  return new Set([...selected].filter((id) => !drop.has(id)))
}

export function allSelected(models: readonly DiscoveredModel[], selected: ReadonlySet<string>): boolean {
  return models.length > 0 && models.every((model) => selected.has(model.id))
}

/**
 * Who the pool's clear button may remove: rows in the current view that no
 * assignment references. In-use rows are never silently deleted by a bulk
 * action - the held count is shown so the promise matches the act.
 */
export function splitRemovable(rows: readonly HubProfile[], assignedProfileIds: ReadonlySet<string>): { removable: HubProfile[]; held: number } {
  const removable = rows.filter((row) => !assignedProfileIds.has(row.id))
  return { removable, held: rows.length - removable.length }
}

/** The pool's left rail: 全部, one entry per provider, plus orphan rows. */
export type PoolFilterKey = 'all' | 'legacy' | string // otherwise a provider id

export interface PoolFilterOption {
  key: PoolFilterKey
  count: number
}

export function poolFilters(providers: readonly HubProvider[], profiles: readonly HubProfile[]): PoolFilterOption[] {
  const legacy = profiles.filter((profile) => profile.providerId === undefined || !providers.some((provider) => provider.id === profile.providerId)).length
  return [
    { key: 'all', count: profiles.length },
    ...providers.map((provider) => ({ key: provider.id, count: profiles.filter((profile) => profile.providerId === provider.id).length })),
    ...(legacy > 0 ? [{ key: 'legacy' as const, count: legacy }] : []),
  ]
}

export function filterPool(
  profiles: readonly HubProfile[],
  providers: readonly HubProvider[],
  filter: PoolFilterKey,
  query: string,
): HubProfile[] {
  const needle = query.trim().toLowerCase()
  return profiles
    .filter((profile) => {
      if (filter === 'all') return true
      if (filter === 'legacy') return profile.providerId === undefined || !providers.some((provider) => provider.id === profile.providerId)
      return profile.providerId === filter
    })
    .filter((profile) => needle === '' || `${profile.displayName} ${profile.modelId}`.toLowerCase().includes(needle))
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
}

export interface ModelDeclaredCapabilities {
  context: number | undefined
  inputTypes: string[]
  reasoning: boolean | undefined
}

/**
 * What the endpoint declared for this model, read back from the settings the
 * import wrote. Missing stays missing: the table renders '—', never a guess.
 */
export function declaredCapabilities(profile: HubProfile): ModelDeclaredCapabilities {
  const settings = profile.settings
  const context = typeof settings.contextWindow === 'number' && settings.contextWindow >= 1_024 ? settings.contextWindow : undefined
  const rawTypes = Array.isArray(settings.inputTypes) ? settings.inputTypes : []
  const inputTypes = rawTypes.filter((item): item is string => item === 'text' || item === 'image' || item === 'video' || item === 'audio')
  const reasoning = typeof settings.reasoning === 'boolean' ? settings.reasoning : undefined
  return { context, inputTypes, reasoning }
}

export function formatContext(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value >= 1_048_576) return `${Math.round(value / 1_048_576)}M`
  return value >= 1_024 ? `${Math.round(value / 1_024)}K` : String(value)
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
