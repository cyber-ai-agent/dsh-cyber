import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises'

import { worldTemplate } from '@dsh-cyber/catalog'
import type { CyberPackageManifest, EmployeeBlueprint, JsonObject } from '@dsh-cyber/contracts'
import type {
  EmbodiedEmployeeBlueprint,
  EmbodimentProfile,
  WorkshopCreateInput,
  WorkshopProject,
  WorkshopRoleDefinition,
} from '@dsh-cyber/contracts/creative-platform'
import type { PackageManager } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { embodimentToBehaviorJson, parseEmbodimentProfile } from '../embodiment-profile.js'
import { ServiceError } from './service-error.js'
import { WorldRootService } from './world-root-service.js'
import { WorldSettingsService } from './world-settings-service.js'

const PROJECT_VERSION = 1 as const
const MAX_ROLES = 16

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

    const world = this.#store.createWorld({
      workspaceId,
      name: normalized.displayName,
      templateId: normalized.baseTemplateId,
      actorId: 'owner',
    })
    await this.#worldRoots.ensure(world.id)
    await this.#worldSettings.save(world.id, {
      lore: normalized.lore,
      scenario: normalized.scenario,
    })

    const generatedPackageIds: string[] = []
    const storedRoles: WorkshopRoleDefinition[] = []
    for (let index = 0; index < normalized.roles.length; index += 1) {
      const role = normalized.roles[index]!
      const roleId = role.id || `role-${index + 1}`
      const packageId = `${projectId}.${slug(roleId) || `role${index + 1}`}`.slice(0, 150)
      const blueprint: EmbodiedEmployeeBlueprint = {
        schemaVersion: 1,
        id: packageId,
        version: 1,
        worldTemplateId: normalized.baseTemplateId,
        displayName: role.displayName,
        role: role.role,
        summary: role.summary,
        persona: role.persona,
        requestedSkills: role.skillIds,
        requestedCapabilities: [],
        embodiment: role.embodiment,
        createdAt: now,
      }
      const roleDirectory = safeChild(join(projectDirectory, 'generated', 'roles'), packageId)
      const manifest = await materializeRolePackage(roleDirectory, blueprint)
      const preview = this.#packageManager.preview(workspaceId, manifest)
      await this.#packageManager.install({
        workspaceId,
        manifest,
        sourceDirectory: roleDirectory,
        approvalToken: preview.approvalToken,
        actorId: 'owner',
      })
      this.#store.saveBlueprint(blueprint as EmployeeBlueprint)
      const character = this.#store.recruitEmployee({
        workspaceId,
        worldId: world.id,
        blueprintId: blueprint.id,
        blueprintVersion: blueprint.version,
        displayName: role.displayName,
        skillGrants: role.skillIds,
        actorId: 'owner',
        reason: 'creative-workshop',
      })
      const currentProfile = this.#store.getEmployeeProfile(character.id)
      this.#store.reviseEmployeeProfile({
        employeeId: character.id,
        background: currentProfile?.background ?? role.summary,
        personalityTraits: currentProfile?.personalityTraits ?? [],
        appearance: {
          ...(currentProfile?.appearance ?? {}),
          worldBehaviorProfile: embodimentToBehaviorJson(
            `${blueprint.id}@${blueprint.version}`,
            blueprint.embodiment!,
          ) as unknown as JsonObject,
          ...(blueprint.embodiment?.actorRigId === undefined ? {} : { actorRigId: blueprint.embodiment.actorRigId }),
        },
        reason: 'creative-workshop-embodiment',
        actorId: 'owner',
      })
      generatedPackageIds.push(packageId)
      storedRoles.push({
        id: roleId,
        displayName: role.displayName,
        role: role.role,
        summary: role.summary,
        persona: role.persona,
        embodiment: role.embodiment,
        skillIds: role.skillIds,
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
      roles: storedRoles,
      generatedPackageIds,
      createdAt: now,
      updatedAt: now,
    }
    await atomicWrite(join(projectDirectory, 'project.json'), `${JSON.stringify(project, null, 2)}\n`)
    return project
  }

  async readProject(workspaceId: string, projectId: string): Promise<WorkshopProject> {
    const path = join(safeChild(this.#projectRoot, projectId), 'project.json')
    const project = parseStoredProject(JSON.parse(await readFile(path, 'utf8')))
    if (project.workspaceId !== workspaceId) throw new ServiceError('forbidden', 'workshop_project_forbidden', '项目不属于当前本地实例')
    return project
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
      skillIds: uniqueTokens(value.skillIds ?? [], `角色 ${index + 1} 技能`),
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

function parseStoredProject(value: unknown): WorkshopProject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workshop project')
  const project = value as WorkshopProject
  if (project.schemaVersion !== 1 || !project.id || !project.workspaceId || !project.worldId || !Array.isArray(project.roles)) {
    throw new Error('Invalid workshop project')
  }
  return project
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
