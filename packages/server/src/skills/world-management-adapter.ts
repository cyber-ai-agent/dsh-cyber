import type { JsonObject } from '@dsh-cyber/contracts'
import type {
  CharacterSkillAction,
  CharacterSkillDescriptor,
} from '@dsh-cyber/contracts/skill-runtime'
import {
  RECOMMENDED_ADMIN_PERMISSIONS,
  type WorldAuthorityActor,
  type WorldCharacterPermission,
  type WorldCharacterRole,
} from '@dsh-cyber/contracts/world-authority'

import type {
  CharacterSkillActionProposal,
  CharacterSkillAdapter,
  CharacterSkillExecutionContext,
  CharacterSkillExecutionResult,
  CharacterSkillMatchContext,
  CharacterSkillPreflightResult,
} from './skill-adapter.js'
import {
  WorldManagementIntentParser,
  type WorldAuthorityOperation,
  type WorldManagementCharacterRef,
} from '../services/world-management-intent-parser.js'
import type { WorldAuthorityPort } from '../services/world-permission-request-service.js'

export interface WorldManagementSettingsPort {
  get(worldId: string): Promise<Record<string, unknown>>
  getSnapshot?(worldId: string): Promise<{ settings: Record<string, unknown>; revision: number }>
  savePatch?(worldId: string, patch: Record<string, unknown>, expectedRevision: number): Promise<{ settings: Record<string, unknown>; revision: number }>
  save?(worldId: string, value: Record<string, unknown>): Promise<Record<string, unknown>>
}

/**
 * Everything this adapter publishes, it must be able to perform.
 *
 * Each member here backs a descriptor below, so they are required rather than
 * optional: an incomplete composition root is a compile error instead of a
 * runtime "服务不可用" the user discovers. `world.rename` and
 * `world.characters.update` shipped advertised-but-unwired precisely because
 * these were optional.
 */
export interface WorldManagementHost {
  listCharacters(worldId: string): WorldManagementCharacterRef[]
  settings: WorldManagementSettingsPort
  authority: WorldAuthorityPort
  /** The route/session supplies the real owner or delegating employee actor. */
  managementActor(action: CharacterSkillAction): WorldAuthorityActor
  renameWorld(worldId: string, name: string): Promise<void> | void
  updateCharacter(worldId: string, employeeId: string, patch: Record<string, unknown>): Promise<void> | void
  listPackages(worldId: string): Promise<unknown> | unknown
  instantiatePackage(worldId: string, packageId: string): Promise<void> | void
  disablePackage(worldId: string, packageId: string): Promise<void> | void
  readModel(worldId: string): Promise<unknown> | unknown
  assignModel(worldId: string, modelProfileId: string): Promise<void> | void
  getWorld(worldId: string): { id: string; workspaceId: string } | undefined
}

const AUTHORITY_SOURCE = 'world-authority' as const

export const WORLD_MANAGEMENT_DESCRIPTORS: readonly CharacterSkillDescriptor[] = [
  descriptor('builtin.world.settings.read', '读取世界设置', '查看当前世界的受信任设置快照', 'read', 'world.settings.read'),
  descriptor('builtin.world.settings.update', '修改世界设置', '修改当前世界场景、世界观或称呼', 'write-local', 'world.settings.write'),
  descriptor('builtin.world.rename', '重命名世界', '修改当前世界名称', 'write-local', 'world.settings.write'),
  descriptor('builtin.world.characters.list', '查看角色', '查看当前世界角色列表', 'read', 'world.characters.read'),
  descriptor('builtin.world.characters.update', '修改角色', '修改当前世界角色身份', 'write-local', 'world.characters.manage'),
  descriptor('builtin.world.authority.read', '查看世界权限', '查看当前世界角色权限', 'read', 'world.permissions.read'),
  descriptor('builtin.world.authority.update', '管理世界权限', '修改当前世界角色管理员身份与权限', 'write-local', 'world.permissions.manage'),
  descriptor('builtin.world.packages.list', '查看世界插件', '查看当前世界插件实例', 'read', 'world.packages.read'),
  descriptor('builtin.world.packages.instantiate', '启用世界插件', '实例化当前世界已有插件', 'write-local', 'world.packages.manage'),
  descriptor('builtin.world.packages.disable', '停用世界插件', '停用当前世界插件实例', 'write-local', 'world.packages.manage'),
  descriptor('builtin.world.model.read', '查看世界模型', '查看当前世界模型分配', 'read', 'world.model.read'),
  descriptor('builtin.world.model.assign', '修改世界模型', '修改当前世界默认模型', 'write-local', 'world.model.assign'),
]

const descriptors = WORLD_MANAGEMENT_DESCRIPTORS
const descriptorBySkillId = new Map(descriptors.map((item) => [item.id, item]))

/**
 * Which host member each published skill needs. A descriptor missing from this
 * table, or a table entry the host does not satisfy, is a broken promise; a
 * contract test asserts both directions.
 */
export const WORLD_MANAGEMENT_REQUIREMENTS: Readonly<Record<string, keyof WorldManagementHost>> = {
  'builtin.world.settings.read': 'settings',
  'builtin.world.settings.update': 'settings',
  'builtin.world.rename': 'renameWorld',
  'builtin.world.characters.list': 'listCharacters',
  'builtin.world.characters.update': 'updateCharacter',
  'builtin.world.authority.read': 'authority',
  'builtin.world.authority.update': 'authority',
  'builtin.world.packages.list': 'listPackages',
  'builtin.world.packages.instantiate': 'instantiatePackage',
  'builtin.world.packages.disable': 'disablePackage',
  'builtin.world.model.read': 'readModel',
  'builtin.world.model.assign': 'assignModel',
}

/** Action names the execute switch handles, kept in step with the descriptors. */
export const WORLD_MANAGEMENT_HANDLED_ACTIONS: readonly string[] = [
  'world.settings.read',
  'world.settings.update',
  'world.rename',
  'world.characters.list',
  'world.characters.update',
  'world.authority.read',
  'world.authority.update',
  'world.packages.list',
  'world.packages.instantiate',
  'world.packages.disable',
  'world.model.read',
  'world.model.assign',
]

/** Descriptor ids are the action name behind a `builtin.` prefix. */
export function worldManagementAction(skillId: string): string {
  return skillId.replace(/^builtin\./, '')
}

function descriptor(
  id: string,
  displayName: string,
  summary: string,
  risk: 'read' | 'write-local',
  permission: WorldCharacterPermission,
): CharacterSkillDescriptor {
  return {
    id,
    displayName,
    summary,
    adapterId: 'builtin.world-management',
    risks: [risk],
    supportsScheduling: false,
    persistentApproval: 'forbidden',
    authorizationSource: AUTHORITY_SOURCE,
    requiredWorldPermission: permission,
  }
}

/** Trusted host adapter for world-local control-plane mutations. */
export class WorldManagementAdapter implements CharacterSkillAdapter {
  readonly id = 'builtin.world-management'
  readonly descriptors = descriptors
  readonly authorizationSource = AUTHORITY_SOURCE
  readonly #host: WorldManagementHost
  readonly #parser: WorldManagementIntentParser

  constructor(host: WorldManagementHost, parser = new WorldManagementIntentParser()) {
    this.#host = host
    this.#parser = parser
  }

  propose(context: CharacterSkillMatchContext): CharacterSkillActionProposal[] {
    if (context.promptSource !== undefined && context.promptSource !== 'raw-user') return []
    const characters = this.#host.listCharacters?.(context.worldId) ?? []
    const plan = this.#parser.compile(context.prompt, { worldId: context.worldId, characters }, 'raw-user')
    // A clause the compiler could not read is reported on the first action of
    // the plan, so the character can tell the user what it did not do instead
    // of quietly performing half the request.
    const unhandled = plan.unhandled.length > 0 ? { unhandledClauses: plan.unhandled } : {}
    return plan.proposals.map((proposal, index) => ({
      skillId: proposal.skillId,
      adapterId: this.id,
      action: proposal.action,
      target: proposal.target,
      label: proposal.label,
      risk: descriptorBySkillId.get(proposal.skillId)?.risks[0] ?? 'write-local',
      authorization: 'explicit-user-request',
      authorizationSource: AUTHORITY_SOURCE,
      requiredWorldPermission: proposal.requiredWorldPermission,
      parameters: {
        ...proposal.parameters,
        managementKind: proposal.kind,
        ...(proposal.ordinal === undefined ? {} : { planOrdinal: proposal.ordinal, planSize: plan.proposals.length }),
        ...(index === 0 ? unhandled : {}),
      },
    }))
  }

  async preflight(action: CharacterSkillAction): Promise<CharacterSkillPreflightResult> {
    if (this.#host.getWorld !== undefined && this.#host.getWorld(action.worldId) === undefined) {
      return { ready: false, detail: '当前世界不存在' }
    }
    if (action.action === 'world.authority.update') {
      const employeeId = stringParameter(action.parameters, 'employeeId')
      const characters = this.#host.listCharacters?.(action.worldId) ?? []
      if (employeeId === undefined || characters.every((item) => item.id !== employeeId)) {
        return { ready: false, detail: '目标角色不属于当前世界' }
      }
    }
    return { ready: true }
  }

  async execute(action: CharacterSkillAction, _context: CharacterSkillExecutionContext): Promise<CharacterSkillExecutionResult> {
    try {
      switch (action.action) {
        case 'world.settings.read': return await this.#readSettings(action)
        case 'world.settings.update': return await this.#updateSettings(action)
        case 'world.rename': return await this.#rename(action)
        case 'world.characters.list': return this.#listCharacters(action)
        case 'world.characters.update': return await this.#updateCharacter(action)
        case 'world.authority.read': return await this.#readAuthority(action)
        case 'world.authority.update': return await this.#updateAuthority(action)
        case 'world.packages.list': return await this.#listPackages(action)
        case 'world.packages.instantiate': return await this.#instantiatePackage(action)
        case 'world.packages.disable': return await this.#disablePackage(action)
        case 'world.model.read': return await this.#readModel(action)
        case 'world.model.assign': return await this.#assignModel(action)
        default: return { status: 'failed', detail: '未知的世界管理动作，已阻止执行' }
      }
    } catch (error) {
      return { status: 'failed', detail: error instanceof Error ? error.message : '世界管理动作执行失败' }
    }
  }

  async #readSettings(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    if (this.#host.settings === undefined) return { status: 'failed', detail: '世界设置服务不可用' }
    const snapshot = this.#host.settings.getSnapshot === undefined
      ? await this.#host.settings.get(action.worldId)
      : await this.#host.settings.getSnapshot(action.worldId)
    return { status: 'executed', detail: `当前世界设置已读取：${safeSummary(snapshot)}` }
  }

  async #updateSettings(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const settings = this.#host.settings
    if (settings === undefined) return { status: 'failed', detail: '世界设置服务不可用' }
    const patch = withoutManagementFields(action.parameters)
    let expectedRevision: number | undefined
    if (settings.getSnapshot !== undefined && settings.savePatch !== undefined) {
      const before = await settings.getSnapshot(action.worldId)
      expectedRevision = before.revision
      await settings.savePatch(action.worldId, patch, expectedRevision)
      const after = await settings.getSnapshot(action.worldId)
      if (!patchMatches(after.settings, patch)) return { status: 'failed', detail: '世界设置写入后校验失败' }
      return { status: 'executed', detail: `世界设置已更新（revision ${after.revision}）` }
    }
    if (settings.save === undefined) return { status: 'failed', detail: '世界设置 CAS 服务不可用' }
    const saved = await settings.save(action.worldId, patch)
    return { status: patchMatches(saved, patch) ? 'executed' : 'failed', detail: patchMatches(saved, patch) ? '世界设置已更新' : '世界设置写入后校验失败' }
  }

  async #rename(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const name = stringParameter(action.parameters, 'name')
    if (name === undefined || this.#host.renameWorld === undefined) return { status: 'failed', detail: '世界重命名服务不可用或名称无效' }
    await this.#host.renameWorld(action.worldId, name)
    return { status: 'executed', detail: `世界已重命名为“${name}”` }
  }

  #listCharacters(action: CharacterSkillAction): CharacterSkillExecutionResult {
    // Reporting "0 characters" when the capability is absent is worse than
    // failing: it is a confident wrong answer the model will repeat.
    if (this.#host.listCharacters === undefined) return { status: 'failed', detail: '角色列表服务不可用' }
    const list = this.#host.listCharacters(action.worldId)
    return { status: 'executed', detail: `当前世界共有 ${list.length} 个可用角色` }
  }

  async #updateCharacter(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const employeeId = stringParameter(action.parameters, 'employeeId')
    const role = stringParameter(action.parameters, 'role')
    if (employeeId === undefined || role === undefined || this.#host.updateCharacter === undefined) return { status: 'failed', detail: '角色更新服务不可用或参数无效' }
    await this.#host.updateCharacter(action.worldId, employeeId, { role })
    return { status: 'executed', detail: '角色身份已更新' }
  }

  async #readAuthority(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const employeeId = stringParameter(action.parameters, 'employeeId')
    if (employeeId === undefined || this.#host.authority === undefined) return { status: 'failed', detail: '世界权限服务不可用或目标无效' }
    const authority = await this.#host.authority.get(action.worldId, employeeId)
    if (authority === undefined) return { status: 'failed', detail: '未找到目标角色的世界权限' }
    return { status: 'executed', detail: `角色当前为${authority.role === 'administrator' ? '世界管理员' : '普通角色'}，已授予 ${authority.permissionGrants.length} 项世界权限` }
  }

  async #updateAuthority(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const authority = this.#host.authority
    const employeeId = stringParameter(action.parameters, 'employeeId')
    if (authority?.updateAuthority === undefined || employeeId === undefined) return { status: 'failed', detail: '世界权限管理服务不可用或目标无效' }
    const current = await authority.get(action.worldId, employeeId)
    if (current === undefined) return { status: 'failed', detail: '未找到目标角色的世界权限' }
    const operation = authorityOperation(action.parameters, current.role)
    const requested = arrayParameter(action.parameters, 'permissionGrants')
    const remove = arrayParameter(action.parameters, 'removePermissions')
    // The role only changes when the user asked for it. A grant or a revoke
    // carries the current role through untouched, and adds to or subtracts
    // from the grants that already exist rather than replacing the set — the
    // replacement semantics used to demote administrators and erase every
    // permission the utterance did not happen to name.
    const base = operation === 'promote'
      ? [...current.permissionGrants, ...RECOMMENDED_ADMIN_PERMISSIONS, ...requested]
      : operation === 'revoke'
        ? current.permissionGrants
        : [...current.permissionGrants, ...requested]
    const next = [...new Set(base)].filter((permission) => !remove.includes(permission))
    const role: WorldCharacterRole = operation === 'promote'
      ? 'administrator'
      : operation === 'demote' ? 'member' : current.role
    const saved = await authority.updateAuthority({
      worldId: action.worldId,
      targetEmployeeId: employeeId,
      actor: this.#host.managementActor?.(action) ?? { kind: 'employee', id: action.characterId },
      role,
      permissionGrants: next,
      reason: action.label,
      ...(operation === 'demote' ? { allowManagementStrip: true } : {}),
    })
    // Report what was persisted, not what was requested: the two diverged
    // whenever the service filtered or refused something.
    const persisted = saved?.permissionGrants ?? next
    const roleLabel = (saved?.role ?? role) === 'administrator' ? '世界管理员' : '普通角色'
    return { status: 'executed', detail: `角色当前为${roleLabel}，持有 ${persisted.length} 项世界权限` }
  }

  async #listPackages(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    if (this.#host.listPackages === undefined) return { status: 'failed', detail: '世界插件服务不可用' }
    return { status: 'executed', detail: `当前世界插件：${safeSummary(await this.#host.listPackages(action.worldId))}` }
  }

  async #instantiatePackage(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const packageId = stringParameter(action.parameters, 'packageId')
    if (packageId === undefined || this.#host.instantiatePackage === undefined) return { status: 'failed', detail: '插件实例化服务不可用或标识无效' }
    await this.#host.instantiatePackage(action.worldId, packageId)
    return { status: 'executed', detail: `已在当前世界启用插件 ${packageId}` }
  }

  async #disablePackage(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const packageId = stringParameter(action.parameters, 'packageId')
    if (packageId === undefined || this.#host.disablePackage === undefined) return { status: 'failed', detail: '插件停用服务不可用或标识无效' }
    await this.#host.disablePackage(action.worldId, packageId)
    return { status: 'executed', detail: `已在当前世界停用插件 ${packageId}` }
  }

  async #readModel(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    if (this.#host.readModel === undefined) return { status: 'failed', detail: '模型服务不可用' }
    return { status: 'executed', detail: `当前世界模型：${safeSummary(await this.#host.readModel(action.worldId))}` }
  }

  async #assignModel(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const modelProfileId = stringParameter(action.parameters, 'modelProfileId')
    if (modelProfileId === undefined || this.#host.assignModel === undefined) return { status: 'failed', detail: '模型分配服务不可用或标识无效' }
    await this.#host.assignModel(action.worldId, modelProfileId)
    return { status: 'executed', detail: `已将当前世界默认模型设为 ${modelProfileId}` }
  }
}

function stringParameter(parameters: Record<string, unknown>, key: string): string | undefined {
  const value = parameters[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function arrayParameter(parameters: Record<string, unknown>, key: string): WorldCharacterPermission[] {
  const value = parameters[key]
  return Array.isArray(value) ? value.filter((item): item is WorldCharacterPermission => typeof item === 'string') : []
}

function withoutManagementFields(parameters: Record<string, unknown>): Record<string, unknown> {
  const result = { ...parameters }
  delete result.managementKind
  delete result.employeeId
  delete result.displayName
  delete result.role
  delete result.permissionGrants
  delete result.removePermissions
  return result
}

function patchMatches(value: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([key, expected]) => {
    const actual = value[key]
    if (expected !== null && typeof expected === 'object' && actual !== null && typeof actual === 'object') {
      return patchMatches(actual as Record<string, unknown>, expected as Record<string, unknown>)
    }
    return actual === expected
  })
}

/**
 * Reads the requested operation, tolerating the older role-shaped payload.
 *
 * Durable actions written before operations existed still carry `role`, and a
 * restart must be able to finish them.
 */
function authorityOperation(parameters: JsonObject, currentRole: WorldCharacterRole): WorldAuthorityOperation {
  const operation = stringParameter(parameters, 'operation')
  if (operation === 'promote' || operation === 'demote' || operation === 'grant' || operation === 'revoke') return operation
  const role = stringParameter(parameters, 'role')
  if (role === 'administrator') return 'promote'
  if (role === 'member' && currentRole === 'administrator') return 'demote'
  return arrayParameter(parameters, 'removePermissions').length > 0 ? 'revoke' : 'grant'
}

function safeSummary(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return (text ?? '已读取').slice(0, 500)
  } catch { return '已读取' }
}
