import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'

import type {
  CharacterSkillDescriptor,
  InstalledPackage,
  SkillDetailFile,
  SkillDetailView,
  SkillCatalogAvailability,
  SkillCatalogAvailabilityReason,
  SkillCatalogEntry,
  SkillCatalogScope,
  SkillCatalogSource,
  SkillDependency,
  SkillSettingsScope,
  SkillSettingsView,
  SkillDocumentDescriptor,
  SkillDocumentReadRequest,
  SkillDocumentReadResult,
} from '@dsh-cyber/contracts'
import type { SkillScopeSettingsRepository, SqliteStore } from '@dsh-cyber/persistence'

import {
  loadInstalledSkills,
  InstalledPackageVerificationCache,
  type InstalledSkillManifest,
} from '../installed-package-runtime.js'
import { skillSourceFromAdapter } from '../skill-manifest.js'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import type { WorldSkillAvailabilityInput, WorldSkillAvailabilityPort } from './world-skill-availability.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'
import { parseSkillMarkdown } from './skill-markdown-import.js'

type CatalogStore = Pick<SqliteStore, 'getWorkspace' | 'getWorld' | 'listInstalledPackages'> & Partial<Pick<SqliteStore, 'listWorlds' | 'listWorldPackageInstances'>>
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
  packageInfo: {
    id: string
    version: string
    displayName: string
    summary: string
  }
}

interface PackageSkillIndex {
  bySkillId: Map<string, PackageSkillRecord>
  conflicts: Set<string>
}

interface EffectiveSkillSelection {
  skillIds: Set<string>
  disabledReason: Extract<SkillCatalogAvailabilityReason, 'world-disabled' | 'workspace-disabled'>
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
  readonly #documentFiles = new InstalledPackageVerificationCache()

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
    const selection = this.#effectiveScopeSelection(world.workspaceId, world.id)
    const selected = selection?.skillIds
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
    return selection === undefined ? items : items.map((item) => selection.skillIds.has(item.id)
      ? item
      : { ...item, worldAvailable: false, availability: 'unavailable', availabilityReason: selection.disabledReason })
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
    if (input.skillIds.length === 0) return []
    const available = new Set(await this.availableSkillIds(input))
    const manifests = await loadInstalledSkills(await this.#worldPackages.listRuntimePackages(input.worldId))
    return manifests.filter((item) => available.has(item.manifest.id) && item.manifest.integrationId === 'builtin.recipe')
      .map((item) => `${item.manifest.displayName}：${item.manifest.instructions.trim()}`)
  }

  /** Only metadata enters the turn prefix. Bodies remain in the immutable package. */
  async documentsForWorld(input: Omit<WorldSkillAvailabilityInput, 'skillId'> & { skillIds: readonly string[] }): Promise<SkillDocumentDescriptor[]> {
    const world = this.#store.getWorld(input.worldId)
    if (world?.workspaceId !== input.workspaceId || world.status !== 'active' || input.skillIds.length === 0) return []
    const wanted = new Set(input.skillIds)
    const entries = (await this.listWorld(input.worldId)).filter((entry) => wanted.has(entry.id) && entry.worldAvailable && entry.kind === 'recipe')
    const packages = await this.#worldPackages.listRuntimePackages(input.worldId)
    const latestWorld = this.#store.getWorld(input.worldId)
    if (latestWorld?.workspaceId !== input.workspaceId || latestWorld.status !== 'active') return []
    const latestSelection = this.#effectiveScopeSelection(input.workspaceId, input.worldId)?.skillIds
    const latestInstances = this.#store.listWorldPackageInstances?.(input.worldId, 'active')
    return entries.flatMap((entry): SkillDocumentDescriptor[] => {
      if (latestSelection !== undefined && !latestSelection.has(entry.id)) return []
      const installed = packages.find((item) => item.status === 'active' && item.workspaceId === input.workspaceId && item.packageId === entry.packageId && item.version === entry.packageVersion)
      if (installed !== undefined && latestInstances !== undefined && !latestInstances.some((instance) => instance.packageId === installed.packageId && instance.packageVersion === installed.version)) return []
      const recipe = entry.packageId === undefined ? this.#registry.recipeForSkill?.(entry.id) : undefined
      if (installed === undefined && recipe === undefined) return []
      const revision = documentRevision(installed === undefined ? recipe : { id: installed.packageId, version: installed.version, files: installed.manifest.files })
      return [{ id: entry.id, displayName: entry.displayName, summary: entry.summary, revision }]
    })
  }

  async readDocumentForWorld(input: Omit<WorldSkillAvailabilityInput, 'skillId'> & SkillDocumentReadRequest & { expectedRevision: string; redactText?: (text: string) => string }): Promise<SkillDocumentReadResult> {
    const current = async () => {
      const descriptor = (await this.documentsForWorld({ ...input, skillIds: [input.skillId] }))[0]
      if (descriptor === undefined || descriptor.revision !== input.expectedRevision) throw new Error('工作方法已停用或版本已改变，请在下一轮重新加载。')
      return descriptor
    }
    const descriptor = await current()
    const packages = (await this.#worldPackages.listRuntimePackages(input.worldId)).filter((item) => item.workspaceId === input.workspaceId && item.status === 'active')
    const records = await loadInstalledSkills(packages.filter((item) => item.manifest.entrypoints?.some((entry) => entry.kind === 'skill' && entry.id === input.skillId)))
    const record = records.find((item) => item.manifest.id === input.skillId)
    let content: string
    let path: string
    let resources: string[] = []
    if (record === undefined) {
      const recipe = this.#registry.recipeForSkill?.(input.skillId)
      if (recipe === undefined || documentRevision(recipe) !== descriptor.revision) throw new Error('工作方法不存在。')
      path = 'SKILL.md'
      if (input.path !== undefined && input.path !== path) throw new Error('工作方法没有此引用文件。')
      content = recipe.instruction
    } else {
      const installed = packages.find((item) => item.packageId === record.packageId && item.version === record.packageVersion)!
      if (documentRevision({ id: installed.packageId, version: installed.version, files: installed.manifest.files }) !== descriptor.revision) throw new Error('工作方法版本已改变。')
      const bodyPath = 'SKILL.md'
      path = input.path ?? bodyPath
      resources = [...(record.manifest.resources ?? [])]
      if (path === bodyPath) {
        if (record.manifest.instructionFile === undefined) content = record.manifest.instructions
        else {
          content = await readDocumentText(this.#documentFiles, installed, record.manifest.instructionFile)
          if (basename(record.manifest.instructionFile) === 'SKILL.md') content = parseSkillMarkdown(content).body
        }
      } else {
        if (!resources.includes(path)) throw new Error('工作方法没有声明此引用文件。')
        content = await readDocumentText(this.#documentFiles, installed, path)
      }
    }
    // Redact complete values BEFORE paging, including credentials spanning a
    // page boundary. Cursors describe the safe text, never the raw source.
    content = input.redactText?.(content) ?? content
    const offset = boundedInteger(input.offset, 0, 0, content.length, 'offset')
    const limit = boundedInteger(input.limit, 8_000, 1, 12_000, 'limit')
    let end = Math.min(content.length, offset + limit)
    if (offset > 0 && /[\uD800-\uDBFF]/u.test(content[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(content[offset] ?? '')) throw new Error('工作方法 offset 不能分割 Unicode 字符。')
    if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(content[end]!)) end -= 1
    if (end === offset && offset < content.length) throw new Error('工作方法 limit 太小，请至少使用 2 个字符。')
    const resourceOffset = boundedInteger(input.resourceOffset, 0, 0, resources.length, 'resourceOffset')
    const totalResources = resources.length
    resources = resources.slice(resourceOffset, resourceOffset + 8)
    const resourceEnd = resourceOffset + resources.length
    // A package may have been removed/rebound while the file was being read.
    await current()
    return { skillId: input.skillId, revision: descriptor.revision, path, content: content.slice(offset, end), totalChars: content.length, resources, totalResources,
      ...(resourceEnd < totalResources ? { nextResourceOffset: resourceEnd } : {}),
      ...(end < content.length ? { nextOffset: end } : {}) }
  }

  #effectiveScopeSelection(workspaceId: string, worldId: string): EffectiveSkillSelection | undefined {
    const world = this.#scopeSettings?.get(workspaceId, 'world', worldId)
    if (world !== undefined) return { skillIds: new Set(world.skillIds), disabledReason: 'world-disabled' }
    const global = this.#scopeSettings?.get(workspaceId, 'workspace', workspaceId)
    return global === undefined ? undefined : { skillIds: new Set(global.skillIds), disabledReason: 'workspace-disabled' }
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
    const entries = await this.listWorld(input.worldId)
    // listWorld performs package I/O. Read current authority again after that
    // await, so a revocation during the final read check cannot use its earlier
    // scope or active-instance snapshot.
    const latestWorld = this.#store.getWorld(input.worldId)
    if (latestWorld?.workspaceId !== input.workspaceId || latestWorld.status !== 'active') return []
    const selected = this.#effectiveScopeSelection(input.workspaceId, input.worldId)?.skillIds
    const instances = this.#store.listWorldPackageInstances?.(input.worldId, 'active')
    const available = new Set(
      entries.filter((item) => item.worldAvailable && (selected === undefined || selected.has(item.id))
          && (item.packageId === undefined || instances === undefined || instances.some((instance) => instance.packageId === item.packageId && instance.packageVersion === item.packageVersion)))
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
            packageInfo: {
              id: installed.packageId,
              version: installed.version,
              displayName: installed.manifest.displayName,
              summary: installed.manifest.summary,
            },
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
    const availabilityReason = input.worldScoped
      ? worldUnavailableReason({ descriptor, worldPackage, packageBound, hasConflict, source })
      : workspaceUnavailableReason({ descriptor, packageRecord, hasConflict })
    const worldAvailable = availabilityReason === undefined
    const scope = catalogScope({ source, worldScoped: input.worldScoped, packageBound })
    const base = descriptor ?? unboundPackageDescriptor(packageRecord)
    if (base === undefined) continue
    const routingHints = mergeRoutingHints(descriptor?.routingHints, packageRecord?.manifest.routingHints)
    const dependencies = mergeDependencies(descriptor?.dependencies, packageRecord?.manifest.dependencies, packageRecord?.manifest.integrationId)
    const entry: SkillCatalogEntry = {
      ...cloneDescriptor(base),
      ...(routingHints === undefined ? {} : { routingHints }),
      ...(dependencies.length === 0 ? {} : { dependencies }),
      source,
      scope,
      globalKnown,
      worldAvailable,
      availability: availability(worldAvailable),
      ...(availabilityReason === undefined ? {} : { availabilityReason }),
      ...(packageRecord === undefined ? {} : {
        packageId: packageRecord.packageId,
        packageVersion: packageRecord.packageVersion,
        skillPackage: packageRecord.packageInfo,
      }),
    }
    entries.push(entry)
  }

  return entries.sort((left, right) =>
    left.displayName.localeCompare(right.displayName, 'zh-CN') || left.id.localeCompare(right.id),
  )
}

function worldUnavailableReason(input: {
  descriptor: CharacterSkillDescriptor | undefined
  worldPackage: PackageSkillRecord | undefined
  packageBound: boolean
  hasConflict: boolean
  source: SkillCatalogSource
}): SkillCatalogAvailabilityReason | undefined {
  if (input.hasConflict) return 'package-conflict'
  if (isDeclarativeRecipe(input.worldPackage)) return undefined
  if (input.source === 'builtin' || input.source === 'mcp' || !input.packageBound) {
    return input.descriptor === undefined ? 'adapter-unavailable' : undefined
  }
  if (input.worldPackage === undefined) return 'package-unavailable'
  if (input.descriptor === undefined) return 'adapter-unavailable'
  return input.descriptor.packageId === undefined || input.descriptor.packageId === input.worldPackage.packageId
    ? undefined
    : 'adapter-package-mismatch'
}

function workspaceUnavailableReason(input: {
  descriptor: CharacterSkillDescriptor | undefined
  packageRecord: PackageSkillRecord | undefined
  hasConflict: boolean
}): SkillCatalogAvailabilityReason | undefined {
  if (input.hasConflict) return 'package-conflict'
  if (input.packageRecord !== undefined) {
    if (isDeclarativeRecipe(input.packageRecord)) return undefined
    const descriptor = input.packageRecord.descriptor
    if (descriptor === undefined) return 'adapter-unavailable'
    return descriptor.packageId === undefined || descriptor.packageId === input.packageRecord.packageId
      ? undefined
      : 'adapter-package-mismatch'
  }
  if (input.descriptor?.packageId !== undefined) return 'package-unavailable'
  return input.descriptor === undefined ? 'adapter-unavailable' : undefined
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
  const verification = new InstalledPackageVerificationCache()
  const files: SkillDetailFile[] = []
  for (const declared of installed.manifest.files) {
    const extension = extname(declared.path).toLowerCase()
    if (!['.md', '.json', '.txt'].includes(extension)) continue
    let content: string
    try { content = await readDocumentText(verification, installed, declared.path) }
    catch (error) {
      if (error instanceof Error && ['skill_document_too_large', 'skill_document_not_text'].includes(error.message)) continue
      throw error
    }
    if (content.length > 64_000) continue
    files.push({ path: declared.path, content, language: extension === '.md' ? 'markdown' : extension === '.json' ? 'json' : 'text', editable: installed.packageId.startsWith('generated.skill.') })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

const MAX_DOCUMENT_BYTES = 512 * 1024
async function readDocumentText(verification: InstalledPackageVerificationCache, installed: InstalledPackage, path: string): Promise<string> {
  const file = await verification.openFile(installed, path)
  try {
    if (file.byteLength > MAX_DOCUMENT_BYTES) throw new Error('skill_document_too_large')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of file.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > MAX_DOCUMENT_BYTES) throw new Error('skill_document_too_large')
      chunks.push(bytes)
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
    catch { throw new Error('skill_document_not_text') }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('skill_document_not_text')
    return text
  } finally { file.body.destroy() }
}
function documentRevision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`工作方法 ${label} 超出范围。`)
  return value
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
    ...(descriptor.dependencies === undefined ? {} : { dependencies: descriptor.dependencies.map((dependency) => ({ ...dependency })) }),
    ...(descriptor.routingHints === undefined ? {} : { routingHints: [...descriptor.routingHints] }),
  }
}

function mergeDependencies(
  descriptorDependencies: readonly SkillDependency[] | undefined,
  packageDependencies: readonly SkillDependency[] | undefined,
  legacyIntegrationId: string | undefined,
): SkillDependency[] {
  const result = new Map<string, SkillDependency>()
  for (const dependency of [...(descriptorDependencies ?? []), ...(packageDependencies ?? [])]) {
    const key = `${dependency.kind}:${dependency.id}`
    const previous = result.get(key)
    result.set(key, {
      ...dependency,
      ...(previous?.required === true || dependency.required === true ? { required: true } : {}),
    })
  }
  if (result.size === 0 && descriptorDependencies === undefined && packageDependencies === undefined && legacyIntegrationId !== undefined && legacyIntegrationId !== 'builtin.recipe') {
    result.set(`integration:${legacyIntegrationId}`, { kind: 'integration', id: legacyIntegrationId, required: true })
  }
  return [...result.values()]
}

function compareInstalledPackages(left: InstalledPackage, right: InstalledPackage): number {
  return left.packageId.localeCompare(right.packageId) ||
    left.version.localeCompare(right.version) ||
    left.installedAt.localeCompare(right.installedAt)
}
