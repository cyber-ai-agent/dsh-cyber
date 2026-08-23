import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'

import { worldTemplate } from '@dsh-cyber/catalog'
import type { CyberPackageManifest, EmployeeBlueprint, PackagePermissionPreview } from '@dsh-cyber/contracts'
import type {
  EmbodiedEmployeeBlueprint,
  WorkshopCreateInput,
  WorkshopProject,
  WorkshopRoleDefinition,
} from '@dsh-cyber/contracts/creative-platform'
import type { PackageManager, ReversiblePackageInstallation } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { parseEmbodimentProfile } from '../embodiment-profile.js'
import { ServiceError } from './service-error.js'
import { WorldRootService } from './world-root-service.js'
import { WorldSettingsService } from './world-settings-service.js'

const PROJECT_VERSION = 1 as const
const MAX_ROLES = 16

interface CompiledRolePackage {
  role: WorkshopRoleDefinition
  blueprint: EmbodiedEmployeeBlueprint
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

  constructor(store: SqliteStore, packageManager: PackageManager) {
    this.#store = store
    this.#packageManager = packageManager
    this.#stateRoot = stateRootFromStore(store)
    this.#projectRoot = join(this.#stateRoot, 'workshop', 'projects')
    this.#worldRoots = new WorldRootService(this.#stateRoot)
    this.#worldSettings = new WorldSettingsService(this.#worldRoots)
  }

  async list(workspaceId: string): Promise<WorkshopProject[]> {
    if (this.#store.getWorkspace(workspaceId) === undefined) throw new ServiceError('not-found', 'workspace_not_found', 'Workspace not found')
    await mkdir(this.#projectRoot, { recursive: true, mode: 0o700 })
    const projects: WorkshopProject[] = []
    for (const name of await readdir(this.#projectRoot)) {
      const directory = safeChild(this.#projectRoot, name)
      try {
        const info = await lstat(directory)
        if (info.isSymbolicLink() || !info.isDirectory()) continue
        const project = parseStoredProject(JSON.parse(await readFile(join(directory, 'project.json'), 'utf8')))
        if (project.workspaceId === workspaceId) projects.push(project)
      } catch {
        // A broken local project does not prevent the rest of the workshop from loading.
      }
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  }

  async create(workspaceId: string, input: WorkshopCreateInput): Promise<WorkshopProject> {
    if (this.#store.getWorkspace(workspaceId) === undefined) throw new ServiceError('not-found', 'workspace_not_found', 'Workspace not found')
    const normalized = normalizeCreateInput(input)
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
        this.#store.saveBlueprint(item.blueprint as EmployeeBlueprint)
      }

      const world = this.#store.createWorld({
        workspaceId,
        name: normalized.displayName,
        templateId: normalized.baseTemplateId,
        actorId: 'owner',
      })
      createdWorldId = world.id
      await this.#worldRoots.ensure(world.id)
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
        this.#store.recruitEmployee({
          workspaceId,
          worldId: world.id,
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          displayName: role.displayName,
          actorId: 'owner',
          reason: 'creative-workshop',
        })
      }

      const project: WorkshopProject = {
        schemaVersion: PROJECT_VERSION,
        id: projectId,
        workspaceId,
        worldId: world.id,
        displayName: normalized.displayName,
        baseTemplateId: normalized.baseTemplateId,
        lore: normalized.lore,
        scenario: normalized.scenario,
        roles: compiled.map((item) => item.role),
        generatedPackageIds: compiled.map((item) => item.manifest.id),
        createdAt: now,
        updatedAt: now,
      }
      await atomicWrite(join(projectDirectory, 'project.json'), `${JSON.stringify(project, null, 2)}\n`)
      return project
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
      throw error
    }
  }

  async readProject(workspaceId: string, projectId: string): Promise<WorkshopProject> {
    const path = join(safeChild(this.#projectRoot, projectId), 'project.json')
    const project = parseStoredProject(JSON.parse(await readFile(path, 'utf8')))
    if (project.workspaceId !== workspaceId) throw new ServiceError('forbidden', 'workshop_project_forbidden', '项目不属于当前本地实例')
    return project
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
      const blueprint: EmbodiedEmployeeBlueprint = {
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
      const manifest = await materializeRolePackage(directory, blueprint)
      compiled.push({ role, blueprint, directory, manifest })
    }
    return compiled
  }
}


async function materializeRolePackage(
  directory: string,
  blueprint: EmbodiedEmployeeBlueprint,
): Promise<CyberPackageManifest> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const blueprintPath = 'blueprint.json'
  const content = `${JSON.stringify(blueprint, null, 2)}\n`
  await writeFile(join(directory, blueprintPath), content, { encoding: 'utf8', mode: 0o600 })
  const manifest: CyberPackageManifest = {
    schemaVersion: 1,
    id: blueprint.id,
    version: '1.0.0',
    kind: 'employee-blueprint',
    displayName: blueprint.displayName,
    summary: blueprint.summary,
    license: 'LicenseRef-DSH-Cyber-Local',
    publisher: 'Local Creative Workshop',
    capabilities: ['employee:blueprint'],
    dataEgress: [],
    files: [{ path: blueprintPath, sha256: createHash('sha256').update(content).digest('hex') }],
    entrypoints: [{ id: 'role-blueprint', kind: 'employee-blueprint', path: blueprintPath }],
  }
  await writeFile(
    join(directory, 'dsh-cyber.package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  return manifest
}

function normalizeCreateInput(input: WorkshopCreateInput): Required<Omit<WorkshopCreateInput, 'roles'>> & { roles: WorkshopRoleDefinition[] } {
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
    const embodiment = parseEmbodimentProfile(value.embodiment, `roles[${index}].embodiment`)
    return {
      id,
      displayName: text(value.displayName, `角色 ${index + 1} 名称`, 50),
      role: text(value.role, `角色 ${index + 1} 身份`, 100),
      summary: text(value.summary, `角色 ${index + 1} 简介`, 500),
      persona: text(value.persona, `角色 ${index + 1} 设定`, 2_000),
      embodiment,
      requestedSkillIds: uniqueTokens(value.requestedSkillIds ?? [], `角色 ${index + 1} 技能`),
    }
  })
  return {
    displayName,
    baseTemplateId,
    lore: optionalText(input.lore, 20_000),
    scenario: optionalText(input.scenario, 8_000),
    roles,
  }
}

type LegacyWorkshopRoleDefinition = Omit<WorkshopRoleDefinition, 'requestedSkillIds'> & {
  requestedSkillIds?: string[]
  skillIds?: string[]
}

function parseStoredProject(value: unknown): WorkshopProject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workshop project')
  const project = value as Omit<WorkshopProject, 'roles'> & { roles?: LegacyWorkshopRoleDefinition[] }
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
  return { ...project, roles } as WorkshopProject
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

function safeChild(parent: string, child: string): string {
  const base = resolve(parent)
  const target = resolve(parent, encodeURIComponent(child))
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('Workshop path escaped managed directory')
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
