import type { SkillCatalogEntry } from './skill-catalog.js'

/**
 * Presentation-level grouping of MCP tool skills under one service
 * (connection).
 *
 * Grants, execution and the action ledger stay tool-granular
 * (`mcp.<service>.<tool>`); the MCP command is typed by the user and the
 * adapter resolves the exact tool. This module only answers "how does the
 * panel show one service's tools as a single grantable entry" — checking the
 * service row grants every tool of that service.
 */

export interface McpServiceTool {
  /** The tool name (the grant id without its `mcp.<service>.` prefix). */
  name: string
  /** The tool-level grant id `mcp.<service>.<tool>`. */
  id: string
  /** Whether the tool is available in the current world right now. */
  available: boolean
}

export interface McpServiceGroup {
  /** Stable service slug — the second segment of `mcp.<service>.<tool>`. */
  serviceId: string
  /** Display name: the connection name, or the service slug for orphan grants. */
  label: string
  /** The tools this service currently lists in the catalog (may be empty for orphaned grants). */
  tools: McpServiceTool[]
  /** Every grant of this service the character currently holds, including ids the catalog no longer knows. */
  grantedIds: string[]
  /** At least one catalog tool is available in the world. */
  learnable: boolean
  /** The requested ids belonging to this service (catalog tools and missing ones alike). */
  requestedIds: string[]
  /** At least one requested id belongs to this service. */
  recommended: boolean
  /** Where the aggregated row renders. */
  placement: 'recommended' | 'learnable' | 'unavailable' | 'hidden'
}

/**
 * The minimal item shape groupable into MCP services: any tool descriptor
 * that may carry service metadata. Surfaces that gate availability (the
 * world skill catalog) pass `available`; request-only surfaces (the
 * workshop skill picker) omit it, where every item is grantable.
 */
export interface McpGroupItem {
  id: string
  mcpService?: { id: string; label: string } | undefined
  available?: boolean | undefined
}

/** Whether a catalog entry is one MCP tool descriptor (groupable by service). */
export function isMcpCatalogEntry(entry: SkillCatalogEntry): boolean {
  return entry.mcpService !== undefined
}

/**
 * The service slug of a grant id of the form `mcp.<service>.<tool>`.
 * Service slugs are dot-free (`[a-z0-9-]`), so the first dot after the
 * `mcp.` prefix unambiguously ends the service segment; tool names may
 * contain dots. Two-segment legacy ids have no service and return undefined.
 */
export function mcpServiceOfSkillId(id: string): string | undefined {
  if (!id.startsWith('mcp.')) return undefined
  const tail = id.slice(4)
  const dot = tail.indexOf('.')
  const service = dot > 0 ? tail.slice(0, dot) : ''
  return service === '' ? undefined : service
}

/**
 * One group per MCP service seen in the items or in the current value.
 *
 * A value id whose service no longer has any item (connection removed or
 * discovery failed) still forms a group: the panel can keep showing the
 * service row as "暂不可用" so the stale entry stays revocable instead of
 * flooding one orphan row per tool.
 */
export function groupMcpServicesFromItems(
  items: readonly McpGroupItem[],
  value: readonly string[],
  requested: readonly string[],
): McpServiceGroup[] {
  const byService = new Map<string, { label?: string; tools: McpServiceTool[] }>()
  for (const item of items) {
    if (item.mcpService === undefined) continue
    const bucket = byService.get(item.mcpService.id) ?? { tools: [] }
    bucket.label = item.mcpService.label
    bucket.tools.push({
      name: item.id.slice(`mcp.${item.mcpService.id}.`.length),
      id: item.id,
      available: item.available !== false,
    })
    byService.set(item.mcpService.id, bucket)
  }
  for (const id of value) {
    const service = mcpServiceOfSkillId(id)
    if (service !== undefined && !byService.has(service)) byService.set(service, { tools: [] })
  }

  const groups: McpServiceGroup[] = []
  for (const [serviceId, bucket] of byService) {
    const grantedIds = [...new Set(value.filter((id) => mcpServiceOfSkillId(id) === serviceId))]
    const requestedIds = requested.filter((id) => mcpServiceOfSkillId(id) === serviceId)
    const learnable = bucket.tools.some((tool) => tool.available)
    const recommended = requestedIds.length > 0
    const placement: McpServiceGroup['placement'] = !learnable
      ? (grantedIds.length > 0 ? 'unavailable' : 'hidden')
      : (recommended ? 'recommended' : 'learnable')
    groups.push({
      serviceId,
      label: bucket.label ?? serviceId,
      tools: bucket.tools,
      grantedIds,
      learnable,
      requestedIds,
      recommended,
      placement,
    })
  }
  return groups.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN') || left.serviceId.localeCompare(right.serviceId))
}

/**
 * One group per MCP service seen in the world skill catalog or in the
 * character's grants, with world-availability gating baked in.
 */
export function groupMcpServices(
  catalog: readonly SkillCatalogEntry[],
  value: readonly string[],
  requested: readonly string[],
): McpServiceGroup[] {
  return groupMcpServicesFromItems(
    catalog.map((entry) => ({
      id: entry.id,
      mcpService: entry.mcpService,
      available: entry.worldAvailable && entry.availability === 'available',
    })),
    value,
    requested,
  )
}

/**
 * Services the blueprint requested that no longer have any catalog item
 * (connection removed, disabled, or discovery failed). Surfaces scoped to the
 * template's requests (the recruitment dialog) synthesize one unavailable
 * service row per missing service instead of one orphan row per tool.
 */
export function orphanMcpServiceGroups(
  requested: readonly string[],
  knownServiceIds: readonly string[],
  value: readonly string[],
): McpServiceGroup[] {
  const known = new Set(knownServiceIds)
  const requestedByService = new Map<string, string[]>()
  for (const id of requested) {
    const service = mcpServiceOfSkillId(id)
    if (service !== undefined && !known.has(service)) requestedByService.set(service, [...(requestedByService.get(service) ?? []), id])
  }
  if (requestedByService.size === 0) return []
  const valueSet = new Set(value)
  const groups: McpServiceGroup[] = [...requestedByService.entries()].map(([serviceId, requestedIds]) => ({
    serviceId,
    label: serviceId,
    tools: [],
    grantedIds: requestedIds.filter((id) => valueSet.has(id)),
    learnable: false,
    requestedIds,
    recommended: true,
    placement: 'unavailable' as const,
  }))
  return groups.sort((left, right) => left.serviceId.localeCompare(right.serviceId))
}

/** Add or remove a single skill id in a list of ids (deduped, order-stable). */
export function toggleSkillIdInList(value: readonly string[], skillId: string, checked: boolean): string[] {
  return checked ? [...new Set([...value, skillId])] : value.filter((id) => id !== skillId)
}

/** The grant list after the service row's checkbox changed: grant/revoke every tool of the service. */
export function mcpServiceToggle(group: McpServiceGroup, value: readonly string[], checked: boolean): string[] {
  if (checked) {
    const missing = group.tools
      .filter((tool) => tool.available && !value.includes(tool.id))
      .map((tool) => tool.id)
    return missing.length === 0 ? [...value] : [...value, ...missing]
  }
  return value.filter((id) => mcpServiceOfSkillId(id) !== group.serviceId)
}

/** Checkbox presentation: fully granted checks, any-partial marks indeterminate. */
export function mcpServiceChecked(group: McpServiceGroup, value: readonly string[]): { checked: boolean; indeterminate: boolean } {
  const valueSet = new Set(value)
  const grantable = group.tools.filter((tool) => tool.available)
  if (grantable.length === 0) {
    // An unavailable service row only manages the stale grants it still holds.
    return { checked: group.grantedIds.length > 0, indeterminate: false }
  }
  const allGranted = grantable.every((tool) => valueSet.has(tool.id))
  return { checked: allGranted, indeterminate: group.grantedIds.length > 0 && !allGranted }
}

export type McpServiceStatus = 'unavailable' | 'granted' | 'partial' | 'recommended' | 'learnable'

export function mcpServiceStatus(group: McpServiceGroup, value: readonly string[]): McpServiceStatus {
  const { checked, indeterminate } = mcpServiceChecked(group, value)
  if (group.placement === 'unavailable') return 'unavailable'
  if (checked) return 'granted'
  if (indeterminate) return 'partial'
  if (group.recommended) return 'recommended'
  return 'learnable'
}
