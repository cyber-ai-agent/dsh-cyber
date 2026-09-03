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
  const result: ModelProfile[] = [...configuredProfiles]
  const existingModelIds = new Set(configuredProfiles.map((p) => p.modelId))

  for (const profile of configuredProfiles) {
    const cached = discoveredCatalog[profile.id] ?? discoveredCatalog[profile.baseUrl]
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
        ...((profile as ModelProfile & { credentialConfigured?: boolean }).credentialConfigured !== undefined
          ? { credentialConfigured: (profile as ModelProfile & { credentialConfigured?: boolean }).credentialConfigured }
          : { credentialConfigured: true }),
        ...(profile.credentialEnvName !== undefined ? { credentialEnvName: profile.credentialEnvName } : {}),
        settings: {
          ...baseSettings,
          ...(typeof item.contextLength === 'number' && item.contextLength >= 1_024 ? { contextWindow: item.contextLength } : {}),
          ...(profile.settings?.providerId !== undefined ? { providerId: profile.settings.providerId } : {}),
          providerName: profile.displayName || (typeof profile.settings?.providerName === 'string' ? profile.settings.providerName : undefined),
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
