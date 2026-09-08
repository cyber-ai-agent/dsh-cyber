import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import type { JsonObject } from '@dsh-cyber/contracts'

import { SSH_DEVICE_INTEGRATION_ID } from '../integrations/ssh-provider.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import { SshError, sshExecOnce } from '../integrations/ssh-client.js'
import type {
  CharacterSkillActionProposal,
  CharacterSkillAdapter,
  CharacterSkillExecutionContext,
  CharacterSkillExecutionResult,
  CharacterSkillMatchContext,
  CharacterSkillPreflightResult,
} from './skill-adapter.js'
import { osProbeCommand, parseSshOperation, resolveOs, sshCommandFor, type SshOperation } from './ssh-command-parser.js'

export const SSH_COMMAND_SKILL = 'device.ssh.command'
export const SSH_COMMAND_ADAPTER_ID = 'builtin.ssh-device'

const DESCRIPTOR: CharacterSkillDescriptor = {
  id: SSH_COMMAND_SKILL,
  displayName: 'SSH 设备操作',
  summary: '在已连接并授权的设备上执行受控系统命令（查看状态、重启服务、管理软件包）。凭据只在宿主机加密保存。',
  routingHints: ['ssh', '设备', '主机', '服务器', '磁盘', '重启服务', '安装软件'],
  adapterId: SSH_COMMAND_ADAPTER_ID,
  risks: ['external-side-effect'],
  supportsScheduling: false,
  // The command is derived from parameters; a persistent policy could not
  // bind it. Same rule as Firecrawl/MCP: no exact-target before parameter
  // fingerprints exist.
  persistentApproval: 'forbidden',
  kind: 'integration',
  recommendedByDefault: false,
}

interface WorldRef {
  id: string
  workspaceId: string
}

export interface SshSkillAdapterOptions {
  store: { getWorld(worldId: string): WorldRef | undefined }
  integrations: IntegrationService
  /** Returns the character's current revision grants; undefined blocks connect use. */
  connectionGrantsFor?(characterId: string): readonly string[] | undefined
}

/** Minimal store shape the grants resolver needs (SqliteStore satisfies it). */
export interface ConnectionGrantsRevisionStore {
  getEmployee(employeeId: string): { id: string; currentRevision: number } | undefined
  getEmployeeRevision(employeeId: string, revision: number): { connectionGrants?: readonly string[] } | undefined
}

/**
 * Resolves the current revision's connection grants for an employee. Unknown
 * characters resolve to undefined (deny); revisions without grants resolve to
 * an empty list (deny every device).
 */
export function createConnectionGrantsResolver(store: ConnectionGrantsRevisionStore): (characterId: string) => readonly string[] | undefined {
  return (characterId) => {
    const employee = store.getEmployee(characterId)
    if (employee === undefined) return undefined
    return store.getEmployeeRevision(employee.id, employee.currentRevision)?.connectionGrants ?? []
  }
}

export class SshSkillAdapter implements CharacterSkillAdapter {
  readonly id = SSH_COMMAND_ADAPTER_ID
  readonly descriptors = [DESCRIPTOR] as const
  readonly #store: { getWorld(worldId: string): WorldRef | undefined }
  readonly #integrations: IntegrationService
  readonly #connectionGrantsFor: ((characterId: string) => readonly string[] | undefined) | undefined

  constructor(options: SshSkillAdapterOptions) {
    this.#store = options.store
    this.#integrations = options.integrations
    this.#connectionGrantsFor = options.connectionGrantsFor
  }

  propose(context: CharacterSkillMatchContext): CharacterSkillActionProposal[] {
    if (!context.grantedSkillIds.includes(SSH_COMMAND_SKILL)) return []
    const op = parseSshOperation(context.prompt)
    if (op === undefined) return []
    const world = this.#store.getWorld(context.worldId)
    const deviceLabel = world === undefined ? undefined : this.#resolveDeviceLabel(world.workspaceId, op)
    return [{
      skillId: SSH_COMMAND_SKILL,
      adapterId: this.id,
      action: `ssh.${op.op}`,
      target: 'ssh:device',
      label: deviceLabel === undefined ? op.summary : `${op.summary}（设备：${deviceLabel}）`,
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {
        op: op.op,
        summary: op.summary,
        params: op.params,
        ...(op.connectionId === undefined ? {} : { deviceHint: op.connectionId }),
      },
    }]
  }

  #resolveDeviceLabel(workspaceId: string, op: SshOperation): string | undefined {
    const hint = op.connectionId
    const devices = this.#integrations.listByType(workspaceId, SSH_DEVICE_INTEGRATION_ID)
    if (devices.length === 0) return undefined
    const match = hint === undefined
      ? (devices.length === 1 ? devices[0] : undefined)
      : devices.find((item) => item.displayName === hint || String(item.config.host ?? '') === hint)
    return match?.displayName ?? hint
  }

  async preflight(action: CharacterSkillAction): Promise<CharacterSkillPreflightResult> {
    const world = this.#store.getWorld(action.worldId)
    if (world === undefined) return { ready: false, detail: '当前世界不存在' }
    const op = parseOperationParams(action.parameters)
    if (op === undefined) return { ready: false, detail: 'SSH 动作参数无效' }
    const connectionId = await this.#resolveConnectionId(world.workspaceId, action, op)
    if (connectionId === undefined) {
      return { ready: false, detail: '当前工作区没有可用的 SSH 设备，请先在“连接中心”添加设备' }
    }
    const granted = this.#isConnectionGranted(action.characterId, connectionId)
    if (!granted) return { ready: false, detail: '该角色没有被授权使用这台设备，请在角色设置中勾选对应连接' }
    const connection = this.#integrations.getById(world.workspaceId, connectionId)
    const credential = this.#integrations.credentialForConnection(world.workspaceId, connectionId)
    if (connection === undefined || !connection.enabled || credential === undefined) {
      return { ready: false, detail: '目标设备未启用或缺少私钥凭据' }
    }
    return { ready: true }
  }

  async execute(action: CharacterSkillAction, _context: CharacterSkillExecutionContext): Promise<CharacterSkillExecutionResult> {
    const world = this.#store.getWorld(action.worldId)
    if (world === undefined) return { status: 'failed', detail: '无法确定该设备所属世界' }
    const workspaceId = world.workspaceId
    const op = parseOperationParams(action.parameters)
    if (op === undefined) return { status: 'failed', detail: 'SSH 动作参数无效，未执行任何命令' }
    const connectionId = await this.#resolveConnectionId(workspaceId, action, op)
    if (connectionId === undefined) {
      return { status: 'waiting-for-integration', detail: '没有指定要操作的设备，请先在“连接中心”添加并选择设备' }
    }
    if (!this.#isConnectionGranted(action.characterId, connectionId)) {
      return { status: 'failed', detail: '该角色没有被授权使用这台设备，动作未执行' }
    }
    const connection = this.#integrations.getById(workspaceId, connectionId)
    const credential = this.#integrations.credentialForConnection(workspaceId, connectionId)
    if (connection === undefined || !connection.enabled || credential === undefined) {
      return { status: 'waiting-for-integration', detail: '该设备未启用或尚未配置私钥，未发送任何命令' }
    }
    const config = connection.config
    const device = {
      host: String(config.host ?? connectionId),
      port: Number(config.port ?? 22),
      username: String(config.username ?? 'root'),
      privateKey: credential,
    }
    try {
      const probe = await sshExecOnce(device, osProbeCommand())
      const os = resolveOs(probe.stdout)
      const command = sshCommandFor(op, os)
      if (command === undefined) return { status: 'failed', detail: `当前设备系统暂不支持该操作（detected ${os}）` }
      const result = await sshExecOnce(device, command)
      return { status: 'executed', detail: summarize(op.summary, result.stdout, result.stderr, result.code) }
    } catch (error) {
      if (error instanceof SshError) {
        if (error.kind === 'auth-failed' || error.kind === 'unreachable') {
          return { status: 'failed', detail: error.message }
        }
        return { status: 'outcome-unknown', detail: `${error.message}；不得自动重试` }
      }
      return { status: 'failed', detail: error instanceof Error ? error.message : 'SSH 操作失败' }
    }
  }

  #isConnectionGranted(characterId: string, connectionId: string): boolean {
    if (this.#connectionGrantsFor === undefined) return false
    const grants = this.#connectionGrantsFor(characterId)
    return grants !== undefined && grants.includes(connectionId)
  }

  async #resolveConnectionId(workspaceId: string, action: CharacterSkillAction, op: SshOperation): Promise<string | undefined> {
    const hint = typeof action.parameters.deviceHint === 'string' && action.parameters.deviceHint.trim()
      ? action.parameters.deviceHint.trim()
      : op.connectionId
    const devices = this.#integrations.listByType(workspaceId, SSH_DEVICE_INTEGRATION_ID)
    if (devices.length === 0) return undefined
    if (hint === undefined) return devices.length === 1 ? devices[0]!.id : undefined
    const byName = devices.find((item) => item.displayName === hint || String(item.config.host ?? '') === hint)
    return byName?.id ?? undefined
  }
}

function parseOperationParams(parameters: JsonObject): SshOperation | undefined {
  const op = parameters.op
  const valid = ['system.info', 'disk.usage', 'memory.usage', 'process.list', 'service.restart', 'package.list', 'package.install', 'file.list'] as const
  if (typeof op !== 'string' || !(valid as readonly string[]).includes(op)) return undefined
  const rawParams = parameters.params
  const params: Record<string, string> = {}
  if (rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    for (const [key, value] of Object.entries(rawParams)) {
      if (typeof value === 'string') params[key] = value
    }
  }
  const summary = typeof parameters.summary === 'string' ? parameters.summary : op
  return { op: op as SshOperation['op'], summary, params }
}

function summarize(label: string, stdout: string, stderr: string, code: number | null): string {
  const body = (stdout.trim() || stderr.trim() || `（无输出，exit ${code ?? 'unknown'}）`).slice(0, 800)
  return `${label}：\n${body}`
}
