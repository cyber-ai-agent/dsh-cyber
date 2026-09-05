import type { ModelProfile } from '@dsh-cyber/contracts'

export interface CachedDiscoveredModel {
  id: string
  displayName?: string | undefined
  contextLength?: number | undefined
}

export interface CachedModelCatalog {
  models: CachedDiscoveredModel[]
  baseUrl: string
  providerKind?: string | undefined
  providerName?: string | undefined
  updatedAt: number
}

const STORAGE_KEY = 'dsh:discovered_models_cache:v1'

export function loadDiscoveredModelsCache(): Record<string, CachedModelCatalog> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, CachedModelCatalog>
  } catch {
    return {}
  }
}

export function saveDiscoveredModelsToCache(
  key: string,
  catalog: CachedModelCatalog,
): void {
  try {
    if (typeof localStorage === 'undefined') return
    const current = loadDiscoveredModelsCache()
    current[key] = catalog
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Ignore storage quota/security errors
  }
}

/**
 * The conversation picker is a view of saved profiles, not a discovery catalog.
 * Cached provider catalogs may outlive a removed connection; discovering a
 * model does not configure it. Keep the cache argument for existing callers,
 * but do not inspect it or manufacture selectable profiles from it.
 */
export function buildUnifiedModelList(
  configuredProfiles: readonly ModelProfile[],
  _discoveredCatalog: Record<string, CachedModelCatalog>,
): ModelProfile[] {
  return [...configuredProfiles]
}
