import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import type { JsonObject } from '@dsh-cyber/contracts'

import { SSH_DEVICE_INTEGRATION_ID } from '../integrations/ssh-provider.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import { SshError, SshSessionPool } from '../integrations/ssh-client.js'
import type { SshDeviceCredential } from '../integrations/ssh-client.js'
import { osProbeCommand, parseSshOperation, resolveOs, sshCommandFor, type SshOperation } from './ssh-command-parser.js'
import type {
  CharacterSkillActionProposal,
  CharacterSkillAdapter,
  CharacterSkillExecutionContext,
  CharacterSkillExecutionResult,
  CharacterSkillInstructionContext,
  CharacterSkillMatchContext,
  CharacterSkillPreflightResult,
} from './skill-adapter.js'

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
  /** Shared long-lived sessions; default per-command connection when omitted. */
  sessions?: SshSessionPool
  /**
   * Machine-profile learning: the real SSH result is the only place a device's
   * environment facts can be observed, because skill-action rows persist a
   * human summary rather than the raw output.
   */
  environment?: {
    applySignals?(signals: readonly { toolName?: string; command?: string; failed: boolean; exitCode?: number; output?: string }[], profileId?: string): Promise<unknown>
  }
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

interface DeviceRef {
  id: string
  displayName: string
  host: string
}

export class SshSkillAdapter implements CharacterSkillAdapter {
  readonly id = SSH_COMMAND_ADAPTER_ID
  readonly descriptors = [DESCRIPTOR] as const
  readonly #store: { getWorld(worldId: string): WorldRef | undefined }
  readonly #integrations: IntegrationService
  readonly #connectionGrantsFor: ((characterId: string) => readonly string[] | undefined) | undefined
  readonly #sessions: SshSessionPool | undefined
  readonly #environment: SshSkillAdapterOptions['environment']

  constructor(options: SshSkillAdapterOptions) {
    this.#store = options.store
    this.#integrations = options.integrations
    this.#connectionGrantsFor = options.connectionGrantsFor
    this.#sessions = options.sessions
    this.#environment = options.environment
  }

  /**
   * Per-character capability note folded into the persona. The character
   * learns it can operate its granted devices and how the user phrases a
   * request, so SSH stops being an invisible skill. Credential-free and
   * bounded by the current grant list so it can live in the cacheable prefix.
   */
  instructionsFor(context: CharacterSkillInstructionContext): string[] | undefined {
    if (!context.grantedSkillIds.includes(SSH_COMMAND_SKILL)) return undefined
    if (context.workspaceId === undefined) return undefined
    const devices = this.#grantedDevices(context.workspaceId, context.characterId)
    if (devices.length === 0) {
      return ['SSH 设备操作：你已经获得这项能力，但目前没有授权可操作的设备。请让用户先到“连接中心”添加并启用设备，再到你的角色设置勾选这台设备后，你才能执行设备命令。']
    }
    const lines = devices.map((device) => `- ${device.displayName}（${device.host}）`).join('\n')
    const instruction = devices.length === 1
      ? `你可以操作这台设备，用户说“连这台设备看看磁盘/内存/进程”等自然表达时，你会收到经过批准的受控命令。`
      : `你可以操作这些设备；当用户说出设备名和操作（例如“连${devices[0]!.displayName}看看磁盘”）时，你会收到经过批准的受控命令；用户没有指明是哪台设备时，先问清楚再执行。`
    return [`SSH 设备操作（已授权设备）：\n${lines}\n${instruction}`]
  }

  propose(context: CharacterSkillMatchContext): CharacterSkillActionProposal[] {
    if (!context.grantedSkillIds.includes(SSH_COMMAND_SKILL)) return []
    const world = this.#store.getWorld(context.worldId)
    if (world === undefined) return []
    const devices = this.#grantedDevices(world.workspaceId, context.characterId)
    if (devices.length === 0) return []
    const op = parseSshOperation(context.prompt, {
      deviceCandidates: devices.map(({ displayName, host }) => ({ displayName, host })),
      ...(devices.length === 1 ? { singleDefaultDisplayName: devices[0]!.displayName } : {}),
    })
    if (op === undefined) return []
    const match = matchDevice(devices, op.connectionId)
    if (match === undefined) {
      // The role owns several devices but the user named none (or an unknown
      // one): never guess. The persona note tells the role to ask for it.
      return []
    }
    return [{
      skillId: SSH_COMMAND_SKILL,
      adapterId: this.id,
      action: `ssh.${op.op}`,
      target: 'ssh:device',
      label: `${op.summary}（设备：${match.displayName}）`,
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {
        op: op.op,
        summary: op.summary,
        params: op.params,
        deviceId: match.id,
      },
    }]
  }

  async preflight(action: CharacterSkillAction): Promise<CharacterSkillPreflightResult> {
    const world = this.#store.getWorld(action.worldId)
    if (world === undefined) return { ready: false, detail: '当前世界不存在' }
    if (parseOperationParams(action.parameters) === undefined) return { ready: false, detail: 'SSH 动作参数无效' }
    const connectionId = this.#resolveDeviceId(world.workspaceId, action)
    if (connectionId === undefined) return { ready: false, detail: '没有可用或匹配的 SSH 设备，请先在“连接中心”添加设备' }
    if (!this.#isConnectionGranted(action.characterId, connectionId)) {
      return { ready: false, detail: '该角色没有被授权使用这台设备，请在角色设置中勾选对应连接' }
    }
    if (this.#secretsFor(world.workspaceId, connectionId) === undefined) {
      return { ready: false, detail: '目标设备未启用或缺少私钥/密码凭据' }
    }
    return { ready: true }
  }

  async execute(action: CharacterSkillAction, _context: CharacterSkillExecutionContext): Promise<CharacterSkillExecutionResult> {
    const world = this.#store.getWorld(action.worldId)
    if (world === undefined) return { status: 'failed', detail: '无法确定该设备所属世界' }
    const workspaceId = world.workspaceId
    const op = parseOperationParams(action.parameters)
    if (op === undefined) return { status: 'failed', detail: 'SSH 动作参数无效，未执行任何命令' }
    const connectionId = this.#resolveDeviceId(workspaceId, action)
    if (connectionId === undefined) {
      return { status: 'waiting-for-integration', detail: '没有可用或匹配的 SSH 设备，请先在“连接中心”添加设备' }
    }
    if (!this.#isConnectionGranted(action.characterId, connectionId)) {
      return { status: 'failed', detail: '该角色没有被授权使用这台设备，动作未执行' }
    }
    const secrets = this.#secretsFor(workspaceId, connectionId)
    if (secrets === undefined) {
      return { status: 'waiting-for-integration', detail: '该设备未启用或尚未配置私钥/密码，未发送任何命令' }
    }
    const connection = this.#integrations.getById(workspaceId, connectionId)
    const config = connection?.config
    if (config === undefined) return { status: 'failed', detail: '目标设备信息不存在，未执行任何命令' }
    const device: SshDeviceCredential = {
      host: String(config.host ?? connectionId),
      port: Number(config.port ?? 22),
      username: String(config.username ?? 'root'),
      ...(secrets.privateKey === undefined ? {} : { privateKey: secrets.privateKey }),
      ...(secrets.privateKey !== undefined || secrets.password === undefined ? {} : { password: secrets.password }),
    }
    const exec = (command: string) => this.#sessions === undefined
      ? execFresh(device, command)
      : this.#sessions.exec(device, command)
    try {
      // OS probe and the actual command share one session when pooling is on.
      const probe = await exec(osProbeCommand())
      const os = resolveOs(probe.stdout)
      const command = sshCommandFor(op, os)
      if (command === undefined) return { status: 'failed', detail: `当前设备系统暂不支持该操作（detected ${os}）` }
      const result = await exec(command)
      await this.#recordEnvironment(connectionId, command, result)
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

  /** Granted, enabled and credentialed SSH devices for a character. */
  #grantedDevices(workspaceId: string, characterId: string): DeviceRef[] {
    if (this.#connectionGrantsFor === undefined) return []
    const grants = this.#connectionGrantsFor(characterId)
    if (grants === undefined) return []
    const allowed = new Set(grants)
    const devices: DeviceRef[] = []
    for (const connection of this.#integrations.listByType(workspaceId, SSH_DEVICE_INTEGRATION_ID)) {
      if (!allowed.has(connection.id)) continue
      const secrets = this.#integrations.secretsForConnection(workspaceId, connection.id)
      if (connection.enabled && secrets !== undefined && (secrets.privateKey !== undefined || secrets.password !== undefined)) {
        devices.push({ id: connection.id, displayName: connection.displayName, host: String(connection.config.host ?? '') })
      }
    }
    return devices.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN'))
  }

  /**
   * Feeds the real remote result to that device's profile. Learning never
   * changes the action's outcome: a failed write is the host's problem, not
   * the command's.
   */
  async #recordEnvironment(connectionId: string, command: string, result: { code: number | null; stdout: string; stderr: string }): Promise<void> {
    if (this.#environment?.applySignals === undefined) return
    try {
      await this.#environment.applySignals([{
        toolName: 'ssh',
        command,
        failed: result.code !== 0,
        ...(result.code === null ? {} : { exitCode: result.code }),
        output: `${result.stdout}\n${result.stderr}`,
      }], `ssh:${connectionId}`)
    } catch {
      /* the machine profile is an optimisation of the prompt, not a turn dependency */
    }
  }

  #secretsFor(workspaceId: string, connectionId: string): Record<string, string> | undefined {
    const connection = this.#integrations.getById(workspaceId, connectionId)
    if (connection === undefined || !connection.enabled) return undefined
    const secrets = this.#integrations.secretsForConnection(workspaceId, connectionId)
    return secrets === undefined || (secrets.privateKey === undefined && secrets.password === undefined) ? undefined : secrets
  }

  /** Prefer the approved action's pinned connection id; fall back to legacy hint. */
  #resolveDeviceId(workspaceId: string, action: CharacterSkillAction): string | undefined {
    const pinned = action.parameters.deviceId
    if (typeof pinned === 'string' && pinned.trim()) {
      const connection = this.#integrations.getById(workspaceId, pinned.trim())
      if (connection !== undefined) return connection.id
    }
    const hint = typeof action.parameters.deviceHint === 'string' ? action.parameters.deviceHint.trim() : undefined
    if (hint === undefined) return undefined
    const devices = this.#integrations.listByType(workspaceId, SSH_DEVICE_INTEGRATION_ID)
    return devices.find((item) => item.displayName === hint || String(item.config.host ?? '') === hint)?.id
  }
}

/** Resolve a parser device reference (displayName/host) onto an allowed device. */
function matchDevice(devices: DeviceRef[], reference: string | undefined): DeviceRef | undefined {
  if (reference === undefined) return devices.length === 1 ? devices[0] : undefined
  return devices.find((device) => device.displayName === reference || device.host === reference)
}

async function execFresh(device: SshDeviceCredential, command: string): Promise<import('../integrations/ssh-client.js').SshExecResult> {
  const { sshExecOnce } = await import('../integrations/ssh-client.js')
  return sshExecOnce(device, command)
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
