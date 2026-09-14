import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

import type {
  CharacterSkillDescriptor,
  InstalledPackage,
  SkillDetailFile,
  SkillDetailView,
  SkillCatalogAvailability,
  SkillCatalogEntry,
  SkillCatalogScope,
  SkillCatalogSource,
  SkillSettingsScope,
  SkillSettingsView,
} from '@dsh-cyber/contracts'
import type { SkillScopeSettingsRepository, SqliteStore } from '@dsh-cyber/persistence'

import {
  loadInstalledSkills,
  type InstalledSkillManifest,
} from '../installed-package-runtime.js'
import { skillSourceFromAdapter } from '../skill-manifest.js'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import type { WorldSkillAvailabilityInput, WorldSkillAvailabilityPort } from './world-skill-availability.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'

type CatalogStore = Pick<SqliteStore, 'getWorkspace' | 'getWorld' | 'listInstalledPackages'> & Partial<Pick<SqliteStore, 'listWorlds'>>
type CatalogRegistry = Pick<CharacterSkillAdapterRegistry, 'list'> & Partial<Pick<CharacterSkillAdapterRegistry, 'recipeForSkill'>>
type CatalogWorldPackages = Pick<WorldPackageInstanceService, 'listRuntimePackages'> & Partial<Pick<WorldPackageInstanceService, 'instantiate'>>

export interface SkillCatalogServiceOptions {
  store: CatalogStore
  registry: CatalogRegistry
  worldPackages: CatalogWorldPackages
  scopeSettings?: Pick<SkillScopeSettingsRepository, 'get' | 'save' | 'clear'>
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
 * package and Registry authorities. Catalog definitions remain derived from
 * those sources; persistence stores only scope selections by stable Skill ID.
 */
export class SkillCatalogService implements WorldSkillAvailabilityPort {
  readonly #store: CatalogStore
  readonly #registry: CatalogRegistry
  readonly #worldPackages: CatalogWorldPackages
  readonly #scopeSettings: SkillCatalogServiceOptions['scopeSettings']

  constructor(options: SkillCatalogServiceOptions) {
    this.#store = options.store
    this.#registry = options.registry
    this.#worldPackages = options.worldPackages
    this.#scopeSettings = options.scopeSettings
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
    const packageIndex = await this.#readPackageSkills(packages)
    const selected = this.#effectiveScopeSkillIds(world.workspaceId, world.id)
    let runtimePackages = await this.#worldPackages.listRuntimePackages(worldId)
    if (selected !== undefined && this.#worldPackages.instantiate !== undefined) {
      const activePackageIds = new Set(runtimePackages.map((item) => item.packageId))
      const targets = [...new Set([...selected].flatMap((skillId) => {
        const record = packageIndex.bySkillId.get(skillId)
        return record === undefined || activePackageIds.has(record.packageId) ? [] : [`${record.packageId}\u0000${record.packageVersion}`]
      }))]
      await Promise.allSettled(targets.map((target) => {
        const [packageId, version] = target.split('\u0000') as [string, string]
        return this.#worldPackages.instantiate!({ worldId, packageId, version, actorId: 'skill-scope' })
      }))
      if (targets.length > 0) runtimePackages = await this.#worldPackages.listRuntimePackages(worldId)
    }
    const worldPackageIndex = await this.#readPackageSkills(runtimePackages)
    const items = mergeCatalog({
      descriptors,
      packageIndex,
      worldPackageIndex,
      worldScoped: true,
    })
    return selected === undefined ? items : items.map((item) => selected.has(item.id)
      ? item
      : { ...item, worldAvailable: false, availability: 'unavailable' })
  }

  async listSettings(workspaceId: string): Promise<SkillSettingsView> {
    const workspace = this.#store.getWorkspace(workspaceId)
    if (workspace === undefined) throw new Error(`Workspace not found: ${workspaceId}`)
    const catalog = await this.listWorkspace(workspaceId)
    const global = this.#scopeSettings?.get(workspaceId, 'workspace', workspaceId)
    const globalDefaults = catalog.filter((item) => item.worldAvailable).map((item) => item.id)
    const worlds = await Promise.all((this.#store.listWorlds?.(workspaceId, true) ?? []).map(async (world) => {
      const own = this.#scopeSettings?.get(workspaceId, 'world', world.id)
      const skillIds = own?.skillIds ?? global?.skillIds ?? (await this.#listWorldBase(world.id)).filter((item) => item.worldAvailable).map((item) => item.id)
      return { scope: 'world' as const, scopeId: world.id, displayName: world.name, configured: own !== undefined, inherited: own === undefined && global !== undefined, skillIds: [...skillIds] }
    }))
    return {
      global: { scope: 'workspace', scopeId: workspaceId, displayName: '全局', configured: global !== undefined, inherited: false, skillIds: [...(global?.skillIds ?? globalDefaults)] },
      worlds,
    }
  }

  async saveSettings(input: { workspaceId: string; scope: SkillSettingsScope; scopeId: string; skillIds?: readonly string[]; inherit?: boolean }): Promise<SkillSettingsView> {
    if (this.#scopeSettings === undefined) throw new Error('Skill scope settings are unavailable')
    if (this.#store.getWorkspace(input.workspaceId) === undefined) throw new Error(`Workspace not found: ${input.workspaceId}`)
    if (input.scope === 'workspace' && input.scopeId !== input.workspaceId) throw new Error('Global Skill scope id must match the workspace')
    if (input.scope === 'world' && this.#store.getWorld(input.scopeId)?.workspaceId !== input.workspaceId) throw new Error('World Skill scope does not belong to the workspace')
    if (input.inherit === true) {
      if (input.scope !== 'world') throw new Error('Only a World Skill scope may inherit')
      this.#scopeSettings.clear(input.workspaceId, input.scope, input.scopeId)
      return this.listSettings(input.workspaceId)
    }
    const known = new Set((await this.listWorkspace(input.workspaceId)).map((item) => item.id))
    const skillIds = [...new Set(input.skillIds ?? [])]
    const unknown = skillIds.find((skillId) => !known.has(skillId))
    if (unknown !== undefined) throw new Error(`Unknown Skill: ${unknown}`)
    this.#scopeSettings.save({ workspaceId: input.workspaceId, scope: input.scope, scopeId: input.scopeId, skillIds })
    const targetWorldIds = input.scope === 'workspace'
      ? (this.#store.listWorlds?.(input.workspaceId, true) ?? []).filter((world) => world.status === 'active').map((world) => world.id)
      : [input.scopeId]
    await Promise.all(targetWorldIds.map((worldId) => this.listWorld(worldId)))
    return this.listSettings(input.workspaceId)
  }

  async detailWorkspace(workspaceId: string, skillId: string): Promise<SkillDetailView> {
    const entry = (await this.listWorkspace(workspaceId)).find((item) => item.id === skillId)
    if (entry === undefined) throw new Error(`Skill not found: ${skillId}`)
    const installed = this.#activeWorkspacePackages(workspaceId).find((item) => item.packageId === entry.packageId && item.version === entry.packageVersion)
    if (installed !== undefined) {
      const files = await readSkillFiles(installed)
      return { entry, tree: files.map((file) => ({ path: file.path, kind: 'file' as const })), files, editable: installed.packageId.startsWith('generated.skill.'), packageId: installed.packageId, packageVersion: installed.version }
    }
    const recipe = this.#registry.recipeForSkill?.(skillId)
    const content = recipe === undefined ? JSON.stringify(entry, null, 2) : skillMarkdown(entry, recipe.instruction)
    const file: SkillDetailFile = { path: recipe === undefined ? 'descriptor.json' : 'SKILL.md', content, language: recipe === undefined ? 'json' : 'markdown', editable: false }
    return { entry, tree: [{ path: file.path, kind: 'file' }], files: [file], editable: false }
  }

  async instructionsForWorld(input: Omit<WorldSkillAvailabilityInput, 'skillId'> & { skillIds: readonly string[] }): Promise<string[]> {
    const available = new Set(await this.availableSkillIds(input))
    const manifests = await loadInstalledSkills(await this.#worldPackages.listRuntimePackages(input.worldId))
    return manifests.filter((item) => available.has(item.manifest.id) && item.manifest.integrationId === 'builtin.recipe')
      .map((item) => `${item.manifest.displayName}：${item.manifest.instructions.trim()}`)
  }

  #effectiveScopeSkillIds(workspaceId: string, worldId: string): Set<string> | undefined {
    const world = this.#scopeSettings?.get(workspaceId, 'world', worldId)
    if (world !== undefined) return new Set(world.skillIds)
    const global = this.#scopeSettings?.get(workspaceId, 'workspace', workspaceId)
    return global === undefined ? undefined : new Set(global.skillIds)
  }

  async #listWorldBase(worldId: string): Promise<SkillCatalogEntry[]> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const descriptors = this.#registry.list(world.workspaceId).filter((descriptor) => descriptor.authorizationSource !== 'world-authority')
    const packageIndex = await this.#readPackageSkills(this.#activeWorkspacePackages(world.workspaceId))
    const worldPackageIndex = await this.#readPackageSkills(await this.#worldPackages.listRuntimePackages(worldId))
    return mergeCatalog({ descriptors, packageIndex, worldPackageIndex, worldScoped: true })
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
  if (isDeclarativeRecipe(input.worldPackage)) return true
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
    if (isDeclarativeRecipe(input.packageRecord)) return true
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
    adapterId: isDeclarativeRecipe(record) ? 'builtin.recipe' : 'unbound.package',
    risks: [],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    kind: isDeclarativeRecipe(record) ? 'recipe' : 'integration',
    recommendedByDefault: isDeclarativeRecipe(record),
  }
}

function isDeclarativeRecipe(record: PackageSkillRecord | undefined): boolean {
  return record?.manifest.integrationId === 'builtin.recipe'
}

async function readSkillFiles(installed: InstalledPackage): Promise<SkillDetailFile[]> {
  const root = resolve(installed.installedPath)
  const files: SkillDetailFile[] = []
  for (const declared of installed.manifest.files) {
    const extension = extname(declared.path).toLowerCase()
    if (!['.md', '.json', '.txt'].includes(extension)) continue
    const path = resolve(root, declared.path)
    if (path !== root && !path.startsWith(`${root}${sep}`)) continue
    const content = await readFile(path, 'utf8')
    if (content.length > 64_000) continue
    files.push({ path: declared.path, content, language: extension === '.md' ? 'markdown' : extension === '.json' ? 'json' : 'text', editable: installed.packageId.startsWith('generated.skill.') })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function skillMarkdown(entry: SkillCatalogEntry, instruction: string): string {
  return [`# ${entry.displayName}`, '', entry.summary, '', '## 使用说明', '', instruction.trim(), '', '## Skill ID', '', `\`${entry.id}\``].join('\n')
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
