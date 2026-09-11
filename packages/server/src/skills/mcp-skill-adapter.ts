import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import type { JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { MCP_INTEGRATION_ID, mcpConnectSpecFor, normalizeMcpServiceSlug } from '../integrations/mcp-provider.js'
import type { McpClientFactory, McpToolDefinition } from '../integrations/mcp-client.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import { ServiceError } from '../services/service-error.js'
import type { CharacterSkillActionProposal, CharacterSkillAdapter, CharacterSkillExecutionResult, CharacterSkillMatchContext } from './skill-adapter.js'

export const MCP_ADAPTER_ID = 'builtin.mcp'

interface DiscoveredTool { workspaceId: string; connectionId: string; service: string; skillId: string; tool: McpToolDefinition }

/**
 * MCP is only a transport behind DSH Cyber's capability broker. Discovery
 * creates descriptors; calls still pass Grant -> Approval -> Action Ledger.
 *
 * A workspace may configure several MCP services (`builtin.mcp` multi
 * connections). Each service namespaces its tools with a stable `service`
 * slug, so a skill id is `mcp.<service>.<tool>` and the owning connection is
 * recorded on every discovered tool; execution resolves that connection's
 * credential rather than a single first-connection credential.
 */
export class McpSkillAdapter implements CharacterSkillAdapter {
  readonly id = MCP_ADAPTER_ID
  readonly dynamicDescriptors = true
  readonly #store: Pick<SqliteStore, 'getWorld' | 'listWorkspaces'>
  readonly #integrations: IntegrationService
  readonly #clients: McpClientFactory
  #tools = new Map<string, DiscoveredTool[]>()

  constructor(options: { store: Pick<SqliteStore, 'getWorld' | 'listWorkspaces'>; integrations: IntegrationService; clients: McpClientFactory }) {
    this.#store = options.store; this.#integrations = options.integrations; this.#clients = options.clients
  }

  get descriptors(): readonly CharacterSkillDescriptor[] {
    return [...this.#tools.entries()].map(([skillId, entries]) => ({
      id: skillId,
      displayName: `MCP · ${entries[0]!.service} / ${entries[0]!.tool.name}`,
      summary: safeToolDescription(entries[0]!.tool, entries[0]!.service),
      adapterId: this.id,
      risks: ['external-side-effect'],
      supportsScheduling: false,
      persistentApproval: 'forbidden',
      kind: 'integration',
      recommendedByDefault: false,
    }))
  }

  /**
   * Rediscovers MCP tools, one connection at a time.
   *
   * A connection whose server is unreachable, or whose catalog contains a
   * single malformed tool, loses only its own tools. Previously any failure
   * escaped the loop and the caller cleared the whole catalog, so one bad
   * server discarded every healthy sibling.
   */
  async refresh(): Promise<void> {
    const next = new Map<string, DiscoveredTool[]>()
    const failures: string[] = []
    for (const workspace of this.#store.listWorkspaces()) {
      for (const connection of this.#integrations.listByType(workspace.id, MCP_INTEGRATION_ID)) {
        if (!connection.enabled) continue
        const service = mcpServiceSlugForConnection(connection)
        let client
        try {
          client = await this.#clients.connect(
            mcpConnectSpecFor(connection.config, this.#integrations.credentialForConnection(workspace.id, connection.id)),
          )
          const tools = (await client.listTools()).slice(0, 100)
          const discovered: DiscoveredTool[] = []
          for (const tool of tools) {
            validateTool(tool)
            const skillId = mcpSkillId(service, tool.name)
            if (discovered.some((entry) => entry.skillId === skillId)) {
              throw new Error(`MCP tool id collision: ${tool.name}`)
            }
            discovered.push({ workspaceId: workspace.id, connectionId: connection.id, service, skillId, tool })
          }
          // Only a fully validated catalog is published, so a connection never
          // ends up with half of its tools.
          for (const entry of discovered) {
            next.set(entry.skillId, [...(next.get(entry.skillId) ?? []), entry])
          }
        } catch (error) {
          failures.push(`${workspace.id}/${connection.id}: ${error instanceof Error ? error.message : String(error)}`)
        } finally { await client?.close().catch(() => undefined) }
      }
    }
    this.#tools = next
    if (failures.length > 0) {
      console.warn(`[dsh-cyber] ${failures.length} 个 MCP 连接的工具目录刷新失败：${failures.join('；')}`)
    }
  }

  /** Descriptors a given workspace may actually use. */
  descriptorsFor(workspaceId: string): readonly CharacterSkillDescriptor[] {
    const visible = new Set([...this.#tools.entries()]
      .filter(([, entries]) => entries.some((entry) => entry.workspaceId === workspaceId))
      .map(([skillId]) => skillId))
    return this.descriptors.filter((descriptor) => visible.has(descriptor.id))
  }

  clear(): void { this.#tools = new Map() }

  async propose(context: CharacterSkillMatchContext): Promise<CharacterSkillActionProposal[]> {
    const command = parseMcpCommand(context.prompt)
    if (command === undefined) return []
    const world = this.#store.getWorld(context.worldId)
    if (world === undefined) return []
    const workspaceId = world.workspaceId
    const candidates = this.#resolveCandidates(workspaceId, command.qualifier, context.grantedSkillIds)
    if (candidates.length === 0) return []
    // A bare tool name that several granted services expose is ambiguous: the
    // caller must qualify it with the service (`/mcp <service>.<tool>`).
    if (candidates.length > 1) return []
    const discovered = candidates[0]!
    const payloadRef = await this.#integrations.storeMcpPayload(command.arguments, context.now)
    return [{
      skillId: discovered.skillId,
      adapterId: this.id,
      action: 'mcp.tools.call',
      target: `mcp:${discovered.service}.${discovered.tool.name}`,
      label: `调用 MCP 工具：${discovered.service} / ${discovered.tool.name}`,
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {
        service: discovered.service,
        toolName: discovered.tool.name,
        connectionId: discovered.connectionId,
        payloadRef,
        argumentFields: Object.keys(command.arguments).slice(0, 50),
      },
    }]
  }

  /** Resolve a `/mcp` command qualifier to the discovered tools it may drive. */
  #resolveCandidates(workspaceId: string, qualifier: string, grantedSkillIds: readonly string[]): DiscoveredTool[] {
    const dotIndex = qualifier.indexOf('.')
    const inWorkspace = (entry: DiscoveredTool): boolean => entry.workspaceId === workspaceId
    if (dotIndex > 0) {
      // Targeted form: `/mcp <service>.<tool>`. The slug never contains a dot,
      // so the first dot cleanly splits service from (possibly dotted) tool.
      const service = normalizeMcpServiceSlug(qualifier.slice(0, dotIndex))
      const toolName = qualifier.slice(dotIndex + 1)
      if (!service || !toolName) return []
      const skillId = mcpSkillId(service, toolName)
      if (!grantedSkillIds.includes(skillId)) return []
      return (this.#tools.get(skillId) ?? []).filter((entry) => inWorkspace(entry) && entry.service === service && normalizeToolName(entry.tool.name) === normalizeToolName(toolName))
    }
    // Bare form: `/mcp <tool>`. Resolve across this workspace's services that
    // expose that tool name and that the character is actually granted.
    const toolName = normalizeToolName(qualifier)
    if (!toolName) return []
    const hits: DiscoveredTool[] = []
    for (const entries of this.#tools.values()) {
      for (const entry of entries) {
        if (inWorkspace(entry) && normalizeToolName(entry.tool.name) === toolName && grantedSkillIds.includes(entry.skillId)) hits.push(entry)
      }
    }
    return hits
  }

  preflight(action: CharacterSkillAction) {
    const world = this.#store.getWorld(action.worldId)
    const toolName = typeof action.parameters.toolName === 'string' ? action.parameters.toolName : ''
    const connectionId = typeof action.parameters.connectionId === 'string' ? action.parameters.connectionId : ''
    const payloadRef = typeof action.parameters.payloadRef === 'string' ? action.parameters.payloadRef : ''
    const discovered = world === undefined ? undefined : this.#tools.get(action.skillId)?.find((entry) => entry.workspaceId === world.workspaceId && entry.connectionId === connectionId && entry.tool.name === toolName)
    const connection = world === undefined || !connectionId ? undefined : this.#integrations.getById(world.workspaceId, connectionId)
    return world !== undefined && Boolean(toolName) && Boolean(connectionId) && Boolean(payloadRef) && connection?.enabled === true && discovered !== undefined
      ? { ready: true }
      : { ready: false, detail: '当前工作区的 MCP 连接、工具目录或加密参数不可用' }
  }

  async execute(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const world = this.#store.getWorld(action.worldId)
    const toolName = typeof action.parameters.toolName === 'string' ? action.parameters.toolName : ''
    const connectionId = typeof action.parameters.connectionId === 'string' ? action.parameters.connectionId : ''
    const payloadRef = typeof action.parameters.payloadRef === 'string' ? action.parameters.payloadRef : ''
    if (world === undefined || !toolName || !connectionId || !payloadRef) return { status: 'failed', detail: 'MCP 调用缺少有效世界、工具或加密参数引用' }
    const connection = this.#integrations.getById(world.workspaceId, connectionId)
    const discovered = this.#tools.get(action.skillId)?.find((entry) => entry.workspaceId === world.workspaceId && entry.connectionId === connectionId && entry.tool.name === toolName)
    if (connection === undefined || !connection.enabled || discovered === undefined) return { status: 'waiting-for-integration', detail: '当前工作区的 MCP 连接或工具目录不可用' }
    const args = this.#integrations.resolveMcpPayload(payloadRef)
    if (args === undefined) return { status: 'failed', detail: 'MCP 工具参数已过期或无法解密，未调用外部工具' }
    let client
    try {
      client = await this.#clients.connect(
        mcpConnectSpecFor(connection.config, this.#integrations.credentialForConnection(world.workspaceId, connectionId)),
      )
      const result = await client.callTool(toolName, args)
      return { status: 'executed', detail: summarizeMcpResult(discovered.service, toolName, result) }
    } finally {
      await client?.close().catch(() => undefined)
      await this.#integrations.deleteMcpPayload(payloadRef).catch(() => undefined)
    }
  }

  async discard(action: CharacterSkillAction): Promise<void> {
    const payloadRef = typeof action.parameters.payloadRef === 'string' ? action.parameters.payloadRef : ''
    if (payloadRef) await this.#integrations.deleteMcpPayload(payloadRef)
  }
}

/**
 * A service + tool map to a stable, grantable skill id `mcp.<service>.<tool>`.
 * The service slug is `[a-z0-9-]` (no dots); the tool keeps its dotted
 * normal form.
 */
export function mcpSkillId(service: string, toolName: string): string {
  const normalizedService = normalizeMcpServiceSlug(service)
  const normalizedTool = normalizeToolName(toolName)
  if (!normalizedService || !normalizedTool) throw new Error('MCP skill id requires a service and a tool name')
  return `mcp.${normalizedService}.${normalizedTool}`
}

function mcpServiceSlugForConnection(connection: { config: JsonObject }): string {
  // Reuse the provider's backfill so a legacy connection (no `service` key)
  // resolves to `default` instead of throwing mid-discovery.
  const raw = connection.config.service
  if (raw === undefined) return 'default'
  return normalizeMcpServiceSlug(String(raw))
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized
}

function parseMcpCommand(prompt: string): { qualifier: string; arguments: JsonObject } | undefined {
  // `/mcp <service>.<tool> {json}` (targeted) or `/mcp <tool> {json}` (bare);
  // the qualifier is the single first token and may contain one dot.
  const match = /^\s*\/mcp\s+(\S+)(?:\s+([\s\S]+))?\s*$/i.exec(prompt)
  if (match === null) return undefined
  const qualifier = match[1]!
  if (!/^[A-Za-z0-9_.:/-]+$/.test(qualifier) || qualifier.length > 160) throw new ServiceError('invalid', 'mcp_command_invalid', 'MCP 命令格式无效')
  let value: unknown
  try { value = match[2] === undefined ? {} : JSON.parse(match[2]) }
  catch { throw new ServiceError('invalid', 'mcp_arguments_invalid', 'MCP 工具参数必须是有效的 JSON 对象') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('invalid', 'mcp_arguments_invalid', 'MCP 工具参数必须是 JSON 对象')
  return { qualifier, arguments: value as JsonObject }
}

function validateTool(tool: McpToolDefinition): void {
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool.name)) throw new Error('MCP tool name is invalid')
  if (JSON.stringify(tool.inputSchema).length > 64_000) throw new Error(`MCP tool schema is too large: ${tool.name}`)
}

function safeToolDescription(tool: McpToolDefinition, service: string): string {
  const description = tool.description?.replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
  return description || `由 MCP 服务 ${service} 提供的工具 ${tool.name}。调用前需要明确授权。`
}

function summarizeMcpResult(service: string, toolName: string, value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `MCP 服务 ${service} 的工具 ${toolName} 已完成；原始结果未持久化`
  const record = value as Record<string, unknown>
  const content = Array.isArray(record.content) ? record.content : []
  const types = content.flatMap((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).type === 'string' ? [(item as Record<string, unknown>).type as string] : [])
  const fields = record.structuredContent !== null && typeof record.structuredContent === 'object' && !Array.isArray(record.structuredContent)
    ? Object.keys(record.structuredContent as Record<string, unknown>).slice(0, 20)
    : []
  return `MCP 服务 ${service} 的工具 ${toolName} 已完成，返回 ${content.length} 个内容块${types.length ? `（${[...new Set(types)].join('、')}）` : ''}${fields.length ? `，结构化字段：${fields.join('、')}` : ''}；原始结果未持久化`
}
