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

export function buildUnifiedModelList(
  configuredProfiles: readonly ModelProfile[],
  discoveredCatalog: Record<string, CachedModelCatalog>,
): ModelProfile[] {
  // Build a set of valid model IDs from configured profiles for cache validation
  const validModelIds = new Set(configuredProfiles.map((p) => p.modelId))

  // Filter cache: only keep entries where the base profile still exists
  // and model IDs are still valid (not stale from removed providers)
  const filteredCatalog: Record<string, CachedModelCatalog> = {}
  for (const [key, catalog] of Object.entries(discoveredCatalog)) {
    if (!catalog || !Array.isArray(catalog.models)) continue
    // Filter out models whose IDs no longer exist in configured profiles
    const validModels = catalog.models.filter((item) => item.id && validModelIds.has(item.id))
    if (validModels.length === 0) continue
    filteredCatalog[key] = { ...catalog, models: validModels }
  }

  const result: ModelProfile[] = [...configuredProfiles]
  const existingModelIds = new Set(validModelIds)

  for (const profile of configuredProfiles) {
    const cached = filteredCatalog[profile.id] ?? filteredCatalog[profile.baseUrl]
    if (!cached || !Array.isArray(cached.models)) continue

    for (const item of cached.models) {
      if (!item.id || existingModelIds.has(item.id)) continue
      existingModelIds.add(item.id)

      const { contextWindow: _unusedContext, maxTokens: _unusedMaxTokens, ...baseSettings } = profile.settings
      result.push({
        id: `discovered:${profile.id}:${item.id}`,
        workspaceId: profile.workspaceId,
        displayName: item.displayName || item.id,
        providerKind: profile.providerKind,
        baseUrl: profile.baseUrl,
        modelId: item.id,
        api: profile.api,
        isDefault: false,
        // Inherit the base profile's provider connection so the synthetic
        // model groups under the same named provider in the picker, instead
        // of floating into an anonymous bucket.
        ...(profile.providerId !== undefined ? { providerId: profile.providerId } : {}),
        ...(profile.providerName !== undefined ? { providerName: profile.providerName } : {}),
        ...((profile as ModelProfile & { credentialConfigured?: boolean }).credentialConfigured !== undefined
          ? { credentialConfigured: (profile as ModelProfile & { credentialConfigured?: boolean }).credentialConfigured }
          : { credentialConfigured: true }),
        ...(profile.credentialEnvName !== undefined ? { credentialEnvName: profile.credentialEnvName } : {}),
        settings: {
          ...baseSettings,
          ...(typeof item.contextLength === 'number' && item.contextLength >= 1_024 ? { contextWindow: item.contextLength } : {}),
          ...(profile.providerId !== undefined ? { providerId: profile.providerId } : profile.settings?.providerId !== undefined ? { providerId: profile.settings.providerId } : {}),
          // The provider label must be a provider's name. Falling back to the
          // base profile's displayName let a MODEL name become a provider
          // group in the picker - exactly what owners saw and distrusted.
          ...((profile.providerName ?? (typeof profile.settings?.providerName === 'string' ? profile.settings.providerName : undefined)) !== undefined
            ? { providerName: profile.providerName ?? (profile.settings?.providerName as string) }
            : {}),
          isDiscovered: true,
          baseProfileId: profile.id,
        },
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      } as ModelProfile)
    }
  }

  return result
}
