import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'

import { worldTemplate } from '@dsh-cyber/catalog'
import type { CyberPackageManifest, EmployeeBlueprint, PackagePermissionPreview } from '@dsh-cyber/contracts'
import type {
  WorkshopCreateInput,
  WorkshopProject,
  WorkshopProjectDeletion,
  WorkshopProjectStatus,
  WorkshopProjectView,
  WorkshopRoleDefinition,
} from '@dsh-cyber/contracts/creative-platform'
import type { PackageManager, ReversiblePackageInstallation } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { parseEmbodimentProfile } from '../embodiment-profile.js'
import { KeyedMutex } from './keyed-mutex.js'
import { ServiceError } from './service-error.js'
import { WorldRootService } from './world-root-service.js'
import { WorldSettingsService } from './world-settings-service.js'
import { WorldPackageInstanceService } from './world-package-instance-service.js'
import { compileEmployeeBlueprintPackage } from './employee-blueprint-package-compiler.js'

const PROJECT_VERSION = 1 as const
const MAX_ROLES = 16

// Keyed by the absolute project directory, so every writer of one project file
// is ordered even when several service instances share a state root.
const projectWrites = new KeyedMutex()

interface CompiledRolePackage {
  role: WorkshopRoleDefinition
  blueprint: EmployeeBlueprint
  directory: string
  manifest: CyberPackageManifest
  preview?: PackagePermissionPreview
}

export class CreativeWorkshopService {
  readonly #store: SqliteStore
  readonly #packageManager: PackageManager
  readonly #stateRoot: string
  readonly #projectRoot: string
  readonly #worldRoots: WorldRootService
  readonly #worldSettings: WorldSettingsService
  readonly #worldPackages: WorldPackageInstanceService

  constructor(store: SqliteStore, packageManager: PackageManager) {
    this.#store = store
    this.#packageManager = packageManager
    this.#stateRoot = stateRootFromStore(store)
    this.#projectRoot = join(this.#stateRoot, 'workshop', 'projects')
    this.#worldRoots = new WorldRootService(this.#stateRoot)
    this.#worldSettings = new WorldSettingsService(this.#worldRoots)
    this.#worldPackages = new WorldPackageInstanceService(store, this.#worldRoots)
  }

  async list(workspaceId: string, status: WorkshopProjectStatus | 'all' = 'all'): Promise<WorkshopProjectView[]> {
    if (this.#store.getWorkspace(workspaceId) === undefined) throw new ServiceError('not-found', 'workspace_not_found', 'Workspace not found')
    await mkdir(this.#projectRoot, { recursive: true, mode: 0o700 })
    const projects: WorkshopProjectView[] = []
    for (const name of await readdir(this.#projectRoot)) {
      try {
        const directory = safeChild(this.#projectRoot, name)
        const info = await lstat(directory)
        if (info.isSymbolicLink() || !info.isDirectory()) continue
        const project = parseStoredProject(JSON.parse(await readFile(join(directory, 'project.json'), 'utf8')))
        if (project.workspaceId !== workspaceId) continue
        if (status !== 'all' && project.status !== status) continue
        projects.push(this.#view(project))
      } catch {
        // A broken local project does not prevent the rest of the workshop from loading.
      }
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  async create(workspaceId: string, input: WorkshopCreateInput): Promise<WorkshopProjectView> {
    if (this.#store.getWorkspace(workspaceId) === undefined) throw new ServiceError('not-found', 'workspace_not_found', 'Workspace not found')
    const normalized = normalizeCreateInput(input)
    for (const modelProfileId of [normalized.worldModelProfileId, ...normalized.roles.map((role) => role.modelProfileId)]) {
      if (modelProfileId === undefined) continue
      const profile = this.#store.getModelProfile(modelProfileId)
      if (profile === undefined || profile.workspaceId !== workspaceId) {
        throw new ServiceError('invalid', 'workshop_model_profile_invalid', '创意工坊引用的模型配置不存在或不属于当前工作区')
      }
    }
    if (worldTemplate(normalized.baseTemplateId) === undefined) {
      throw new ServiceError('invalid', 'workshop_template_unknown', '所选基础世界模板不存在')
    }

    const now = new Date().toISOString()
    const projectId = `workshop.${slug(normalized.displayName) || 'world'}.${randomUUID().slice(0, 8)}`
    const projectDirectory = safeChild(this.#projectRoot, projectId)
    await mkdir(join(projectDirectory, 'generated', 'roles'), { recursive: true, mode: 0o700 })
    const reversibleInstalls: ReversiblePackageInstallation[] = []
    let compiled: CompiledRolePackage[] = []
    let createdWorldId: string | undefined

    try {
      // Compile every declarative role package first. World mutation does not begin
      // until all role definitions, manifests and PackageManager previews are valid.
      compiled = await this.#compileRoles(projectId, projectDirectory, normalized.roles, normalized.baseTemplateId, now)
      for (const item of compiled) item.preview = this.#packageManager.preview(workspaceId, item.manifest)

      // PackageManager owns source staging, content verification and per-package rollback.
      // Workshop never bypasses that transaction boundary.
      for (const item of compiled) {
        const preview = item.preview
        if (preview === undefined) throw new Error(`Workshop package was not previewed: ${item.manifest.id}`)
        const installation = await this.#packageManager.installReversible({
          workspaceId,
          manifest: item.manifest,
          sourceDirectory: item.directory,
          approvalToken: preview.approvalToken,
          actorId: 'owner',
        })
        reversibleInstalls.push(installation)
        this.#store.saveBlueprint(item.blueprint)
      }

      const world = this.#store.createWorld({
        workspaceId,
        name: normalized.displayName,
        templateId: normalized.baseTemplateId,
        actorId: 'owner',
      })
      createdWorldId = world.id
      if (normalized.worldModelProfileId !== undefined) {
        this.#store.saveModelAssignment({ workspaceId, scope: 'world', scopeId: world.id, modelProfileId: normalized.worldModelProfileId })
      }
      await this.#worldRoots.ensure(world.id)
      for (const installation of reversibleInstalls) {
        await this.#worldPackages.instantiate({
          worldId: world.id,
          packageId: installation.installed.packageId,
          version: installation.installed.version,
          actorId: 'owner',
        })
      }
      await this.#worldSettings.save(world.id, {
        lore: normalized.lore,
        scenario: normalized.scenario,
      })

      for (const item of compiled) {
        const role = item.role
        const blueprint = item.blueprint
        // Blueprint skill requests are deliberately not grants. This mirrors the
        // Harness/Codex capability boundary: construction declares intent; a later
        // owner approval revises the character's grants.
        const employee = this.#store.recruitEmployee({
          workspaceId,
          worldId: world.id,
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          displayName: role.displayName,
          actorId: 'owner',
          reason: 'creative-workshop',
        })
        if (role.modelProfileId !== undefined) {
          this.#store.saveModelAssignment({ workspaceId, scope: 'employee', scopeId: employee.id, modelProfileId: role.modelProfileId })
        }
      }

      const project: WorkshopProject = {
        schemaVersion: PROJECT_VERSION,
        status: 'active',
        id: projectId,
        workspaceId,
        worldId: world.id,
        displayName: normalized.displayName,
        baseTemplateId: normalized.baseTemplateId,
        lore: normalized.lore,
        scenario: normalized.scenario,
        roles: compiled.map((item) => item.role),
        generatedPackageIds: compiled.map((item) => item.manifest.id),
        ...(normalized.worldModelProfileId === undefined ? {} : { worldModelProfileId: normalized.worldModelProfileId }),
        createdAt: now,
        updatedAt: now,
      }
      await projectWrites.run(projectDirectory, () => writeProjectFile(projectDirectory, project))
      return this.#view(project)
    } catch (error) {
      const compensationFailures: unknown[] = []
      if (createdWorldId !== undefined) {
        try {
          this.#store.rollbackWorldCreation(createdWorldId, 'creative-workshop-build-failed')
        } catch (cause) {
          compensationFailures.push(cause)
        }
        try {
          await this.#worldRoots.remove(createdWorldId)
        } catch (cause) {
          compensationFailures.push(cause)
        }
      }
      for (const item of [...compiled].reverse()) {
        try {
          this.#store.discardBlueprintIfUnused(item.blueprint.id, item.blueprint.version)
        } catch (cause) {
          compensationFailures.push(cause)
        }
      }
      for (const installation of [...reversibleInstalls].reverse()) {
        try {
          await this.#packageManager.compensate(installation, 'creative-workshop-build-failed')
        } catch (cause) {
          compensationFailures.push(cause)
        }
      }
      await rm(projectDirectory, { recursive: true, force: true }).catch((cause) => compensationFailures.push(cause))
      if (compensationFailures.length > 0) {
        throw new AggregateError([error, ...compensationFailures], 'Creative Workshop build failed and compensation was incomplete')
      }
      if (error instanceof ServiceError || error instanceof Error && (error.name === 'PackageInstallError' || error.name === 'PackageApprovalRequiredError')) {
        throw error
      }
      const detail = error instanceof Error && error.message.trim().length > 0 ? `：${error.message}` : ''
      throw new ServiceError('unavailable', 'workshop_build_failed', `创意工坊创建失败，未留下半成品${detail}`)
    }
  }

  async readProject(workspaceId: string, projectId: string): Promise<WorkshopProjectView> {
    return this.#view(await this.#readStored(workspaceId, projectId))
  }

  /** Moves a project into the archive. The linked world is left untouched. */
  async archive(workspaceId: string, projectId: string): Promise<WorkshopProjectView> {
    return this.#view(await this.mutateProject(workspaceId, projectId, (project) => {
      if (project.status === 'archived') return project
      const now = new Date().toISOString()
      return { ...project, status: 'archived', archivedAt: now, updatedAt: now }
    }))
  }

  /** Restores an archived project. A detached project restores just the same. */
  async restore(workspaceId: string, projectId: string): Promise<WorkshopProjectView> {
    return this.#view(await this.mutateProject(workspaceId, projectId, (project) => {
      if (project.status === 'active') return project
      const { archivedAt: _cleared, ...rest } = project
      return { ...rest, status: 'active', updatedAt: new Date().toISOString() }
    }))
  }

  /**
   * Permanently removes the local project directory. It deliberately does not
   * cascade into the world, its characters or its installed packages: project
   * and world lifecycles are independent, so the world survives the deletion.
   */
  async delete(workspaceId: string, projectId: string): Promise<WorkshopProjectDeletion> {
    const directory = safeChild(this.#projectRoot, projectId)
    return projectWrites.run(directory, async () => {
      const project = await this.#readStored(workspaceId, projectId)
      await rm(directory, { recursive: true, force: true })
      return { projectId: project.id, worldId: project.worldId, worldRetained: true }
    })
  }

  async #readStored(workspaceId: string, projectId: string): Promise<WorkshopProject> {
    const path = join(safeChild(this.#projectRoot, projectId), 'project.json')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ServiceError('not-found', 'workshop_project_not_found', '创意工坊项目不存在')
      }
      throw cause
    }
    const project = parseStoredProject(JSON.parse(raw))
    if (project.workspaceId !== workspaceId) throw new ServiceError('forbidden', 'workshop_project_forbidden', '项目不属于当前本地实例')
    return project
  }

  /**
   * Read-modify-write of one stored project, serialized per project.
   *
   * atomicWrite still gives each individual write its crash atomicity; the lock
   * only adds ordering, so two overlapping mutations (archive / restore /
   * delete) cannot read the same snapshot and lose one of the two updates.
   */
  async mutateProject(
    workspaceId: string,
    projectId: string,
    mutate: (project: WorkshopProject) => WorkshopProject | Promise<WorkshopProject>,
  ): Promise<WorkshopProject> {
    const directory = safeChild(this.#projectRoot, projectId)
    return projectWrites.run(directory, async () => {
      const next = await mutate(await this.#readStored(workspaceId, projectId))
      await writeProjectFile(directory, next)
      return next
    })
  }

  /**
   * Resolves the world link at read time. A world id that no longer resolves is
   * a normal detached state, so a failed world lookup never fails the read.
   */
  #view(project: WorkshopProject): WorkshopProjectView {
    let worldLinked = false
    try {
      worldLinked = this.#store.getWorld(project.worldId) !== undefined
    } catch {
      worldLinked = false
    }
    return { ...project, worldLinked }
  }

  async #compileRoles(
    projectId: string,
    projectDirectory: string,
    roles: WorkshopRoleDefinition[],
    baseTemplateId: string,
    createdAt: string,
  ): Promise<CompiledRolePackage[]> {
    const compiled: CompiledRolePackage[] = []
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index]!
      const packageId = `${projectId}.${slug(role.id) || `role${index + 1}`}`.slice(0, 150)
      const blueprint: EmployeeBlueprint = {
        schemaVersion: 1,
        id: packageId,
        version: 1,
        worldTemplateId: baseTemplateId,
        displayName: role.displayName,
        role: role.role,
        summary: role.summary,
        persona: role.persona,
        requestedSkills: role.requestedSkillIds,
        requestedCapabilities: [],
        embodiment: role.embodiment,
        createdAt,
      }
      const directory = safeChild(join(projectDirectory, 'generated', 'roles'), packageId)
      const compiledPackage = await compileEmployeeBlueprintPackage({
        sourceDirectory: directory,
        packageId,
        blueprintVersion: blueprint.version,
        packageVersion: '1.0.0',
        worldTemplateId: blueprint.worldTemplateId,
        displayName: blueprint.displayName,
        role: blueprint.role,
        summary: blueprint.summary,
        persona: blueprint.persona,
        requestedSkills: blueprint.requestedSkills,
        requestedCapabilities: blueprint.requestedCapabilities,
        ...(blueprint.embodiment === undefined ? {} : { embodiment: blueprint.embodiment }),
        createdAt: blueprint.createdAt,
      })
      const manifest = compiledPackage.manifest
      compiled.push({ role, blueprint, directory, manifest })
    }
    return compiled
  }
}

async function writeProjectFile(directory: string, project: WorkshopProject): Promise<void> {
  await atomicWrite(join(directory, 'project.json'), `${JSON.stringify(project, null, 2)}\n`)
}
function normalizeCreateInput(input: WorkshopCreateInput): { displayName: string; baseTemplateId: string; lore: string; scenario: string; worldModelProfileId?: string; roles: WorkshopRoleDefinition[] } {
  const displayName = text(input.displayName, '世界名称', 80)
  const baseTemplateId = token(input.baseTemplateId, '基础模板')
  if (!Array.isArray(input.roles) || input.roles.length < 1 || input.roles.length > MAX_ROLES) {
    throw new ServiceError('invalid', 'workshop_roles_invalid', `创意世界需要 1 到 ${MAX_ROLES} 个初始角色`)
  }
  const ids = new Set<string>()
  const roles = input.roles.map((value, index): WorkshopRoleDefinition => {
    const id = value.id === undefined ? `role-${index + 1}` : token(value.id, `角色 ${index + 1} ID`)
    if (ids.has(id)) throw new ServiceError('invalid', 'workshop_role_duplicate', `角色 ID 重复：${id}`)
    ids.add(id)
    let embodiment: WorkshopRoleDefinition['embodiment']
    try {
      embodiment = parseEmbodimentProfile(value.embodiment, `roles[${index}].embodiment`)
    } catch (cause) {
      throw new ServiceError('invalid', 'workshop_embodiment_invalid', cause instanceof Error ? cause.message : `角色 ${index + 1} 的行为语义无效`)
    }
    return {
      id,
      displayName: text(value.displayName, `角色 ${index + 1} 名称`, 50),
      role: text(value.role, `角色 ${index + 1} 身份`, 100),
      summary: text(value.summary, `角色 ${index + 1} 简介`, 500),
      persona: text(value.persona, `角色 ${index + 1} 设定`, 2_000),
      embodiment,
      requestedSkillIds: uniqueTokens(value.requestedSkillIds ?? [], `角色 ${index + 1} 技能`),
      ...(value.modelProfileId === undefined ? {} : { modelProfileId: token(value.modelProfileId, `角色 ${index + 1} 模型配置`) }),
    }
  })
  return {
    displayName,
    baseTemplateId,
    lore: optionalText(input.lore, 20_000),
    scenario: optionalText(input.scenario, 8_000),
    ...(input.worldModelProfileId === undefined ? {} : { worldModelProfileId: token(input.worldModelProfileId, '世界模型配置') }),
    roles,
  }
}

type LegacyWorkshopRoleDefinition = Omit<WorkshopRoleDefinition, 'requestedSkillIds'> & {
  requestedSkillIds?: string[]
  skillIds?: string[]
}

/**
 * Projects are on-disk JSON, so a file written by an older build must still
 * load. Lifecycle fields are migrated forward on read: a project with no
 * recorded status is active, and a missing updatedAt falls back to createdAt.
 * The normalized shape is persisted the next time the project is written.
 */
function parseStoredProject(value: unknown): WorkshopProject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workshop project')
  const project = value as Omit<WorkshopProject, 'roles' | 'status' | 'archivedAt'> & {
    roles?: LegacyWorkshopRoleDefinition[]
    status?: unknown
    archivedAt?: unknown
  }
  if (project.schemaVersion !== 1 || !project.id || !project.workspaceId || !project.worldId || !Array.isArray(project.roles)) {
    throw new Error('Invalid workshop project')
  }
  const roles = project.roles.map((role) => {
    const { skillIds: legacySkillIds, requestedSkillIds, ...rest } = role
    return {
      ...rest,
      requestedSkillIds: Array.isArray(requestedSkillIds)
        ? [...requestedSkillIds]
        : Array.isArray(legacySkillIds) ? [...legacySkillIds] : [],
    } satisfies WorkshopRoleDefinition
  })
  const { status: storedStatus, archivedAt: storedArchivedAt, ...rest } = project
  const status: WorkshopProjectStatus = storedStatus === 'archived' ? 'archived' : 'active'
  const createdAt = typeof rest.createdAt === 'string' ? rest.createdAt : new Date(0).toISOString()
  const updatedAt = typeof rest.updatedAt === 'string' ? rest.updatedAt : createdAt
  const archivedAt = status === 'archived' && typeof storedArchivedAt === 'string' ? storedArchivedAt : undefined
  return {
    ...rest,
    roles,
    status,
    createdAt,
    updatedAt,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  } as WorkshopProject
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new ServiceError('invalid', 'workshop_input_invalid', `${label}不能为空`)
  const normalized = value.replaceAll('\0', '').trim()
  if (!normalized || normalized.length > max) throw new ServiceError('invalid', 'workshop_input_invalid', `${label}长度不合法`)
  return normalized
}

function optionalText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, max) : ''
}

function token(value: unknown, label: string): string {
  const result = text(value, label, 128).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) throw new ServiceError('invalid', 'workshop_token_invalid', `${label}只能包含字母、数字、点、下划线和连字符`)
  return result
}

function uniqueTokens(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new ServiceError('invalid', 'workshop_skills_invalid', `${label}最多 32 项`)
  const result = value.map((item) => token(item, label))
  if (new Set(result).size !== result.length) throw new ServiceError('invalid', 'workshop_skills_invalid', `${label}不能重复`)
  return result
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 32)
}

function stateRootFromStore(store: SqliteStore): string {
  return dirname(dirname(store.databasePath))
}

// Workshop ids are generated as ASCII slugs (`workshop.<slug>.<uuid8>` and
// `<projectId>.<roleSlug>`). Containment must not depend on that generator
// staying honest, so the segment is validated here and the resolved path is
// then proven to be a direct child of the managed directory.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SEGMENT_LENGTH = 255

function safeChild(parent: string, child: string): string {
  if (typeof child !== 'string' || child.length === 0 || child.length > MAX_SEGMENT_LENGTH || !SAFE_SEGMENT.test(child)) {
    throw new Error('Workshop path segment is not a safe file name')
  }
  const base = resolve(parent)
  // encodeURIComponent is the identity function on a validated segment, so the
  // on-disk layout of every existing project directory is unchanged.
  const target = resolve(base, encodeURIComponent(child))
  const inside = relative(base, target)
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside) || inside.includes(sep)) {
    throw new Error('Workshop path escaped managed directory')
  }
  return target
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}
