import type { CharacterSkillDescriptor, SkillCatalogEntry, SkillCatalogSource } from '@dsh-cyber/contracts'

export type SkillEntityKind = 'mcp-service' | 'skill-package' | 'skill'

/** The common metadata needed to derive one presentation entity. */
export interface SkillEntityItem {
  id: string
  displayName: string
  summary: string
  packageId?: string
  packageVersion?: string
  skillPackage?: SkillCatalogEntry['skillPackage']
  mcpService?: { id: string; label: string }
  source?: SkillCatalogSource
  worldAvailable?: boolean
  availability?: 'available' | 'unavailable'
}

/**
 * One row in a Skill surface. `memberIds` remain the exact ids written to
 * scope settings, character revisions and action authorization records.
 */
export interface SkillEntityGroup<T extends SkillEntityItem = SkillCatalogEntry> {
  key: string
  kind: SkillEntityKind
  primaryId: string
  displayName: string
  summary: string
  source?: SkillCatalogSource
  entries: T[]
  memberIds: string[]
  availableIds: string[]
  packageId?: string
  packageVersion?: string
  skillPackage?: SkillCatalogEntry['skillPackage']
  mcpService?: { id: string; label: string }
}

/** Group MCP services first, then package entrypoints, then standalone Skills. */
export function groupSkillItems<T extends SkillEntityItem>(items: readonly T[]): SkillEntityGroup<T>[] {
  const buckets = new Map<string, { kind: SkillEntityKind; entries: T[] }>()
  for (const item of items) {
    const identity = entityIdentity(item)
    const bucket = buckets.get(identity.key) ?? { kind: identity.kind, entries: [] }
    bucket.entries.push(item)
    buckets.set(identity.key, bucket)
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => toGroup(key, bucket.kind, bucket.entries))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN') || left.key.localeCompare(right.key))
}

export function groupSkillCatalog(items: readonly SkillCatalogEntry[]): SkillEntityGroup[] {
  return groupSkillItems(items)
}

export function groupSearchText<T extends SkillEntityItem>(group: SkillEntityGroup<T>): string {
  return [
    group.displayName,
    group.summary,
    group.packageId,
    group.mcpService?.id,
    ...group.entries.flatMap((item) => [item.id, item.displayName, item.summary]),
  ].filter((item): item is string => item !== undefined).join(' ').toLocaleLowerCase()
}

export function skillEntityMemberLabel<T extends SkillEntityItem>(group: SkillEntityGroup<T>, item: T): string {
  if (group.kind === 'mcp-service' && group.mcpService !== undefined) {
    return item.id.slice(`mcp.${group.mcpService.id}.`.length)
  }
  return item.displayName
}

export function skillEntitySelectionState<T extends SkillEntityItem>(
  group: SkillEntityGroup<T>,
  selected: readonly string[],
): { checked: boolean; indeterminate: boolean; selectedCount: number } {
  const selectedSet = new Set(selected)
  const selectedCount = group.memberIds.filter((id) => selectedSet.has(id)).length
  if (group.availableIds.length === 0) return { checked: selectedCount > 0, indeterminate: false, selectedCount }
  const checked = group.availableIds.every((id) => selectedSet.has(id))
  return { checked, indeterminate: selectedCount > 0 && !checked, selectedCount }
}

/** Toggle all currently available members while removing stale members on revoke. */
export function toggleSkillEntity<T extends SkillEntityItem>(
  group: SkillEntityGroup<T>,
  selected: readonly string[],
  checked: boolean,
): string[] {
  if (!checked) return selected.filter((id) => !group.memberIds.includes(id))
  return [...new Set([...selected, ...group.availableIds])]
}

export function toggleSkillIdInList(value: readonly string[], skillId: string, checked: boolean): string[] {
  return checked ? [...new Set([...value, skillId])] : value.filter((id) => id !== skillId)
}

function entityIdentity(item: SkillEntityItem): { kind: SkillEntityKind; key: string } {
  if (item.mcpService !== undefined) return { kind: 'mcp-service', key: `mcp:${item.mcpService.id}` }
  const packageId = item.packageId ?? item.skillPackage?.id
  const packageVersion = item.packageVersion ?? item.skillPackage?.version
  if (packageId !== undefined) return { kind: 'skill-package', key: `package:${packageId}\u0000${packageVersion ?? ''}` }
  return { kind: 'skill', key: `skill:${item.id}` }
}

function toGroup<T extends SkillEntityItem>(key: string, kind: SkillEntityKind, entries: T[]): SkillEntityGroup<T> {
  const first = entries[0]!
  const mcpService = first.mcpService
  const skillPackage = first.skillPackage
  const displayName = kind === 'mcp-service'
    ? `MCP · ${mcpService?.label ?? mcpService?.id ?? first.displayName}`
    : kind === 'skill-package'
      ? skillPackage?.displayName ?? `技能包 · ${first.packageId ?? first.displayName}`
      : first.displayName
  const memberIds = entries.map((item) => item.id)
  const availableIds = entries
    .filter((item) => item.worldAvailable !== false && item.availability !== 'unavailable')
    .map((item) => item.id)
  return {
    key,
    kind,
    primaryId: first.id,
    displayName,
    summary: kind === 'skill-package' ? skillPackage?.summary ?? first.summary : kind === 'mcp-service'
      ? `来自 ${mcpService?.label ?? 'MCP 服务'} 的 ${entries.length} 个工具。`
      : first.summary,
    ...(first.source === undefined ? {} : { source: first.source }),
    entries: [...entries],
    memberIds,
    availableIds,
    ...(first.packageId === undefined ? first.skillPackage?.id === undefined ? {} : { packageId: first.skillPackage.id } : { packageId: first.packageId }),
    ...(first.packageVersion === undefined ? first.skillPackage?.version === undefined ? {} : { packageVersion: first.skillPackage.version } : { packageVersion: first.packageVersion }),
    ...(skillPackage === undefined ? {} : { skillPackage }),
    ...(mcpService === undefined ? {} : { mcpService }),
  }
}

/** Keep this import visible to TypeScript consumers that only know descriptors. */
export type SkillEntityDescriptor = CharacterSkillDescriptor & Partial<Pick<SkillCatalogEntry, 'packageVersion' | 'skillPackage' | 'source' | 'worldAvailable' | 'availability'>>
