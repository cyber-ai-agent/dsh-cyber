import type {
  CharacterSkillDescriptor,
  InstalledPackage,
  SkillCatalogAvailability,
  SkillCatalogEntry,
  SkillCatalogScope,
  SkillCatalogSource,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import {
  loadInstalledSkills,
  type InstalledSkillManifest,
} from '../installed-package-runtime.js'
import { skillSourceFromAdapter } from '../skill-manifest.js'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import type { WorldSkillAvailabilityInput, WorldSkillAvailabilityPort } from './world-skill-availability.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'

type CatalogStore = Pick<SqliteStore, 'getWorkspace' | 'getWorld' | 'listInstalledPackages'>
type CatalogRegistry = Pick<CharacterSkillAdapterRegistry, 'list'>
type CatalogWorldPackages = Pick<WorldPackageInstanceService, 'listRuntimePackages'>

export interface SkillCatalogServiceOptions {
  store: CatalogStore
  registry: CatalogRegistry
  worldPackages: CatalogWorldPackages
}

interface PackageSkillRecord extends InstalledSkillManifest {
  /** A package declaration is not executable without a matching host descriptor. */
  descriptor?: CharacterSkillDescriptor
}

interface PackageSkillIndex {
  bySkillId: Map<string, PackageSkillRecord>
  conflicts: Set<string>
}

/**
 * Derives global/workspace discovery and World availability from existing
 * package and Registry authorities. Nothing is persisted here: the package
 * library and pinned World Package Instances remain the source of truth.
 */
export class SkillCatalogService implements WorldSkillAvailabilityPort {
  readonly #store: CatalogStore
  readonly #registry: CatalogRegistry
  readonly #worldPackages: CatalogWorldPackages

  constructor(options: SkillCatalogServiceOptions) {
    this.#store = options.store
    this.#registry = options.registry
    this.#worldPackages = options.worldPackages
  }

  /** Workspace/global catalog. World-scoped package activation is not implied. */
  async listWorkspace(workspaceId: string): Promise<SkillCatalogEntry[]> {
    if (this.#store.getWorkspace(workspaceId) === undefined) throw new Error(`Workspace not found: ${workspaceId}`)
    const descriptors = this.#registry.list(workspaceId)
      .filter((descriptor) => descriptor.authorizationSource !== 'world-authority')
    const packages = this.#activeWorkspacePackages(workspaceId)
    const packageIndex = await this.#readPackageSkills(packages)
    return mergeCatalog({
      descriptors,
      packageIndex,
      worldPackageIndex: undefined,
      worldScoped: false,
    })
  }

  /**
   * World catalog. A plugin Skill is available only when the active World
   * Package Instance contains that Skill's pinned package version. Builtins
   * and MCP remain available in their declared builtin/workspace scopes.
   */
  async listWorld(worldId: string): Promise<SkillCatalogEntry[]> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const descriptors = this.#registry.list(world.workspaceId)
      .filter((descriptor) => descriptor.authorizationSource !== 'world-authority')
    const packages = this.#activeWorkspacePackages(world.workspaceId)
    const runtimePackages = await this.#worldPackages.listRuntimePackages(worldId)
    const packageIndex = await this.#readPackageSkills(packages)
    const worldPackageIndex = await this.#readPackageSkills(runtimePackages)
    return mergeCatalog({
      descriptors,
      packageIndex,
      worldPackageIndex,
      worldScoped: true,
    })
  }

  async availableSkillIds(input: Omit<WorldSkillAvailabilityInput, 'skillId'> & { skillIds: readonly string[] }): Promise<string[]> {
    const world = this.#store.getWorld(input.worldId)
    if (world === undefined || world.workspaceId !== input.workspaceId) return []
    const available = new Set(
      (await this.listWorld(input.worldId))
        .filter((item) => item.worldAvailable)
        .map((item) => item.id),
    )
    return input.skillIds.filter((skillId) => available.has(skillId))
  }

  async isAvailable(input: WorldSkillAvailabilityInput): Promise<boolean> {
    return (await this.availableSkillIds({ ...input, skillIds: [input.skillId] })).length === 1
  }

  #activeWorkspacePackages(workspaceId: string): InstalledPackage[] {
    return this.#store.listInstalledPackages(workspaceId)
      .filter((item) => item.status === 'active')
      .sort(compareInstalledPackages)
  }

  async #readPackageSkills(packages: InstalledPackage[]): Promise<PackageSkillIndex> {
    const bySkillId = new Map<string, PackageSkillRecord>()
    const conflicts = new Set<string>()
    for (const installed of packages) {
      try {
        const skills = await loadInstalledSkills([installed])
        const descriptorById = new Map(this.#registry.list(installed.workspaceId).map((item) => [item.id, item]))
        for (const skill of skills) {
          const record: PackageSkillRecord = {
            ...skill,
            ...(descriptorById.get(skill.manifest.id) === undefined
              ? {}
              : { descriptor: descriptorById.get(skill.manifest.id)! }),
          }
          const previous = bySkillId.get(skill.manifest.id)
          if (previous !== undefined && (previous.packageId !== record.packageId || previous.packageVersion !== record.packageVersion)) {
            conflicts.add(skill.manifest.id)
            continue
          }
          bySkillId.set(skill.manifest.id, record)
        }
      } catch {
        // Package installation validates entrypoints before activation. A
        // damaged legacy package must not make the entire Catalog endpoint
        // unavailable; it simply contributes no grantable declaration.
      }
    }
    return { bySkillId, conflicts }
  }
}

function mergeCatalog(input: {
  descriptors: CharacterSkillDescriptor[]
  packageIndex: PackageSkillIndex
  worldPackageIndex: PackageSkillIndex | undefined
  worldScoped: boolean
}): SkillCatalogEntry[] {
  const descriptorById = new Map(input.descriptors.map((descriptor) => [descriptor.id, descriptor]))
  const skillIds = new Set<string>([
    ...descriptorById.keys(),
    ...input.packageIndex.bySkillId.keys(),
    ...(input.worldPackageIndex === undefined ? [] : input.worldPackageIndex.bySkillId.keys()),
  ])
  const entries: SkillCatalogEntry[] = []

  for (const skillId of skillIds) {
    const descriptor = descriptorById.get(skillId)
    const workspacePackage = input.packageIndex.bySkillId.get(skillId)
    const worldPackage = input.worldPackageIndex?.bySkillId.get(skillId)
    const packageRecord = worldPackage ?? workspacePackage
    const source = packageRecord !== undefined || descriptor?.packageId !== undefined
      ? 'plugin'
      : skillSourceFromAdapter(descriptor?.adapterId ?? '', descriptor?.kind)
    const globalKnown = descriptor !== undefined || workspacePackage !== undefined || worldPackage !== undefined
    const hasConflict = input.packageIndex.conflicts.has(skillId) || input.worldPackageIndex?.conflicts.has(skillId) === true
    const packageBound = descriptor?.packageId !== undefined || workspacePackage !== undefined || worldPackage !== undefined
    const worldAvailable = input.worldScoped
      ? isWorldAvailable({ descriptor, worldPackage, packageBound, hasConflict, source })
      : isWorkspaceAvailable({ descriptor, packageRecord, hasConflict })
    const scope = catalogScope({ source, worldScoped: input.worldScoped, packageBound })
    const base = descriptor ?? unboundPackageDescriptor(packageRecord)
    if (base === undefined) continue
    const routingHints = mergeRoutingHints(descriptor?.routingHints, packageRecord?.manifest.routingHints)
    const entry: SkillCatalogEntry = {
      ...cloneDescriptor(base),
      ...(routingHints === undefined ? {} : { routingHints }),
      source,
      scope,
      globalKnown,
      worldAvailable,
      availability: availability(worldAvailable),
      ...(packageRecord === undefined ? {} : {
        packageId: packageRecord.packageId,
        packageVersion: packageRecord.packageVersion,
      }),
    }
    entries.push(entry)
  }

  return entries.sort((left, right) =>
    left.displayName.localeCompare(right.displayName, 'zh-CN') || left.id.localeCompare(right.id),
  )
}

function isWorldAvailable(input: {
  descriptor: CharacterSkillDescriptor | undefined
  worldPackage: PackageSkillRecord | undefined
  packageBound: boolean
  hasConflict: boolean
  source: SkillCatalogSource
}): boolean {
  if (input.hasConflict) return false
  if (input.source === 'builtin' || input.source === 'mcp') return input.descriptor !== undefined
  if (!input.packageBound) return input.descriptor !== undefined
  if (input.worldPackage === undefined || input.descriptor === undefined) return false
  return input.descriptor.packageId === undefined || input.descriptor.packageId === input.worldPackage.packageId
}

function isWorkspaceAvailable(input: {
  descriptor: CharacterSkillDescriptor | undefined
  packageRecord: PackageSkillRecord | undefined
  hasConflict: boolean
}): boolean {
  if (input.hasConflict) return false
  if (input.packageRecord !== undefined) {
    const descriptor = input.packageRecord.descriptor
    return descriptor !== undefined && (descriptor.packageId === undefined || descriptor.packageId === input.packageRecord.packageId)
  }
  if (input.descriptor?.packageId !== undefined) return false
  return input.descriptor !== undefined
}

function catalogScope(input: {
  source: SkillCatalogSource
  worldScoped: boolean
  packageBound: boolean
}): SkillCatalogScope {
  if (input.source === 'builtin') return 'builtin'
  if (input.worldScoped && input.packageBound) return 'world'
  return 'workspace'
}

function availability(worldAvailable: boolean): SkillCatalogAvailability {
  return worldAvailable ? 'available' : 'unavailable'
}

function unboundPackageDescriptor(record: PackageSkillRecord | undefined): CharacterSkillDescriptor | undefined {
  if (record === undefined) return undefined
  return {
    id: record.manifest.id,
    displayName: record.manifest.displayName,
    summary: record.manifest.summary,
    ...(record.manifest.routingHints === undefined ? {} : { routingHints: [...record.manifest.routingHints] }),
    adapterId: 'unbound.package',
    risks: [],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: 'integration',
    recommendedByDefault: false,
  }
}

/**
 * Execution authority belongs to the trusted host descriptor. Installed
 * package manifests may only enrich discovery/routing metadata here; they
 * cannot replace adapter identity, risk, authorization, or execution policy.
 */
function mergeRoutingHints(
  descriptorHints: readonly string[] | undefined,
  packageHints: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...(descriptorHints ?? []), ...(packageHints ?? [])]
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0)
  if (merged.length === 0) return undefined
  return [...new Set(merged)]
}

function cloneDescriptor(descriptor: CharacterSkillDescriptor): CharacterSkillDescriptor {
  return {
    ...descriptor,
    risks: [...descriptor.risks],
    ...(descriptor.routingHints === undefined ? {} : { routingHints: [...descriptor.routingHints] }),
  }
}

function compareInstalledPackages(left: InstalledPackage, right: InstalledPackage): number {
  return left.packageId.localeCompare(right.packageId) ||
    left.version.localeCompare(right.version) ||
    left.installedAt.localeCompare(right.installedAt)
}
