import type { SkillCatalogEntry } from '@dsh-cyber/contracts/skill-runtime'

export type { SkillCatalogEntry }

export interface SkillCatalogResponse {
  items: SkillCatalogEntry[]
}

export function worldBlueprintCatalogPath(worldId: string): string {
  return `/api/catalog/blueprints?worldId=${encodeURIComponent(worldId)}`
}

export function worldSkillCatalogPath(worldId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/skill-catalog`
}

export function normalizeSkillCatalog(value: unknown): SkillCatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  return value.items.map(normalizeSkillCatalogEntry).filter(isDefined)
}

export function normalizeSkillCatalogEntry(value: unknown): SkillCatalogEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const risks = Array.isArray(value.risks) ? value.risks.filter((risk): risk is string => typeof risk === 'string') : []
  const availability = value.availability === 'unavailable' || value.status === 'unavailable' ? 'unavailable' : 'available'
  const worldAvailable = typeof value.worldAvailable === 'boolean' ? value.worldAvailable : availability === 'available'
  const requiredWorldPermission = typeof value.requiredWorldPermission === 'string' ? value.requiredWorldPermission as SkillCatalogEntry['requiredWorldPermission'] : undefined
  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies.slice(0, 64).flatMap((item) => {
      if (!isRecord(item) || (item.kind !== 'integration' && item.kind !== 'skill') || typeof item.id !== 'string' || item.id.trim() === '' || item.id.length > 160) return []
      return [{ kind: item.kind as 'integration' | 'skill', id: item.id, ...(typeof item.required === 'boolean' ? { required: item.required } : {}) }]
    })
    : undefined
  const mcpService = isRecord(value.mcpService) && typeof value.mcpService.id === 'string' && typeof value.mcpService.label === 'string'
    ? { id: value.mcpService.id, label: value.mcpService.label }
    : undefined
  const skillPackage = isRecord(value.skillPackage)
    && typeof value.skillPackage.id === 'string'
    && typeof value.skillPackage.version === 'string'
    && typeof value.skillPackage.displayName === 'string'
    && typeof value.skillPackage.summary === 'string'
    ? {
      id: value.skillPackage.id,
      version: value.skillPackage.version,
      displayName: value.skillPackage.displayName,
      summary: value.skillPackage.summary,
    }
    : undefined
  return {
    id: value.id,
    displayName: typeof value.displayName === 'string' ? value.displayName : value.id,
    summary: typeof value.summary === 'string' ? value.summary : '当前世界可学习的角色技能。',
    adapterId: typeof value.adapterId === 'string' ? value.adapterId : 'unknown',
    risks: risks as SkillCatalogEntry['risks'],
    supportsScheduling: value.supportsScheduling === true,
    persistentApproval: value.persistentApproval === 'exact-target' ? 'exact-target' : 'forbidden',
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(value.authorizationSource === 'world-authority' ? { authorizationSource: value.authorizationSource } : {}),
    ...(requiredWorldPermission === undefined ? {} : { requiredWorldPermission }),
    ...(value.kind === 'integration' ? { kind: 'integration' as const } : value.kind === 'recipe' ? { kind: 'recipe' as const } : {}),
    recommendedByDefault: value.recommendedByDefault === true,
    ...(mcpService === undefined ? {} : { mcpService }),
    source: value.source === 'plugin' || value.source === 'mcp' || value.source === 'other' ? value.source : 'builtin',
    scope: value.scope === 'workspace' || value.scope === 'world' ? value.scope : 'builtin',
    globalKnown: value.globalKnown !== false,
    worldAvailable,
    availability,
    ...(typeof value.packageId === 'string' ? { packageId: value.packageId } : {}),
    ...(typeof value.packageVersion === 'string' ? { packageVersion: value.packageVersion } : {}),
    ...(skillPackage === undefined ? {} : { skillPackage }),
  }
}

export function skillCatalogErrorMessage(cause: unknown): string {
  if (cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message) && !cause.message.startsWith('Request failed:')) return cause.message
  return '当前世界技能目录暂时无法读取，请稍后重试。'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
