import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'
import type { JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { MCP_INTEGRATION_ID, mcpEndpoint } from '../integrations/mcp-provider.js'
import type { McpClientFactory, McpToolDefinition } from '../integrations/mcp-client.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import { ServiceError } from '../services/service-error.js'
import type { CharacterSkillActionProposal, CharacterSkillAdapter, CharacterSkillExecutionResult, CharacterSkillMatchContext } from './skill-adapter.js'

export const MCP_ADAPTER_ID = 'builtin.mcp'

interface DiscoveredTool { workspaceId: string; skillId: string; tool: McpToolDefinition }

/**
 * MCP is only a transport behind DSH Cyber's capability broker. Discovery
 * creates descriptors; calls still pass Grant -> Approval -> Action Ledger.
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
      displayName: `MCP · ${entries[0]!.tool.name}`,
      summary: safeToolDescription(entries[0]!.tool),
      adapterId: this.id,
      risks: ['external-side-effect'],
      supportsScheduling: false,
      persistentApproval: 'forbidden',
      kind: 'integration',
      recommendedByDefault: false,
    }))
  }

  /**
   * Rediscovers MCP tools, one workspace at a time.
   *
   * A workspace whose server is unreachable, or whose catalog contains a single
   * malformed tool, loses only its own tools. Previously any failure escaped
   * the loop and the caller cleared the whole catalog, so one bad server
   * discarded every healthy sibling.
   */
  async refresh(): Promise<void> {
    const next = new Map<string, DiscoveredTool[]>()
    const failures: string[] = []
    for (const workspace of this.#store.listWorkspaces()) {
      const connection = this.#integrations.get(workspace.id, MCP_INTEGRATION_ID)
      if (connection === undefined || !connection.enabled) continue
      let client
      try {
        client = await this.#clients.connect(mcpEndpoint(connection.config), this.#integrations.credential(workspace.id, MCP_INTEGRATION_ID))
        const tools = (await client.listTools()).slice(0, 100)
        const discovered: DiscoveredTool[] = []
        for (const tool of tools) {
          validateTool(tool)
          const skillId = mcpSkillId(tool.name)
          if (discovered.some((entry) => entry.skillId === skillId && entry.tool.name !== tool.name)) {
            throw new Error(`MCP tool id collision: ${tool.name}`)
          }
          discovered.push({ workspaceId: workspace.id, skillId, tool })
        }
        // Only a fully validated catalog is published, so a workspace never
        // ends up with half of its tools.
        for (const entry of discovered) {
          next.set(entry.skillId, [...(next.get(entry.skillId) ?? []), entry])
        }
      } catch (error) {
        failures.push(`${workspace.id}: ${error instanceof Error ? error.message : String(error)}`)
      } finally { await client?.close().catch(() => undefined) }
    }
    this.#tools = next
    if (failures.length > 0) {
      console.warn(`[dsh-cyber] ${failures.length} 个工作区的 MCP 工具目录刷新失败：${failures.join('；')}`)
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
    const skillId = mcpSkillId(command.toolName)
    if (!context.grantedSkillIds.includes(skillId)) return []
    const world = this.#store.getWorld(context.worldId)
    const discovered = this.#tools.get(skillId)?.find((entry) => entry.workspaceId === world?.workspaceId && entry.tool.name === command.toolName)
    if (discovered === undefined) return []
    const payloadRef = await this.#integrations.storeMcpPayload(command.arguments, context.now)
    return [{
      skillId,
      adapterId: this.id,
      action: 'mcp.tools.call',
      target: `mcp:${command.toolName}`,
      label: `调用 MCP 工具：${command.toolName}`,
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: { toolName: command.toolName, payloadRef, argumentFields: Object.keys(command.arguments).slice(0, 50) },
    }]
  }

  preflight(action: CharacterSkillAction) {
    const world = this.#store.getWorld(action.worldId)
    const toolName = typeof action.parameters.toolName === 'string' ? action.parameters.toolName : ''
    const payloadRef = typeof action.parameters.payloadRef === 'string' ? action.parameters.payloadRef : ''
    const connection = world === undefined ? undefined : this.#integrations.get(world.workspaceId, MCP_INTEGRATION_ID)
    const discovered = world === undefined ? undefined : this.#tools.get(action.skillId)?.find((entry) => entry.workspaceId === world.workspaceId && entry.tool.name === toolName)
    return world !== undefined && Boolean(toolName) && Boolean(payloadRef) && connection?.enabled === true && discovered !== undefined
      ? { ready: true }
      : { ready: false, detail: '当前工作区的 MCP 连接、工具目录或加密参数不可用' }
  }

  async execute(action: CharacterSkillAction): Promise<CharacterSkillExecutionResult> {
    const world = this.#store.getWorld(action.worldId)
    const toolName = typeof action.parameters.toolName === 'string' ? action.parameters.toolName : ''
    const payloadRef = typeof action.parameters.payloadRef === 'string' ? action.parameters.payloadRef : ''
    if (world === undefined || !toolName || !payloadRef) return { status: 'failed', detail: 'MCP 调用缺少有效世界、工具或加密参数引用' }
    const connection = this.#integrations.get(world.workspaceId, MCP_INTEGRATION_ID)
    const discovered = this.#tools.get(action.skillId)?.find((entry) => entry.workspaceId === world.workspaceId && entry.tool.name === toolName)
    if (connection === undefined || !connection.enabled || discovered === undefined) return { status: 'waiting-for-integration', detail: '当前工作区的 MCP 连接或工具目录不可用' }
    const args = this.#integrations.resolveMcpPayload(payloadRef)
    if (args === undefined) return { status: 'failed', detail: 'MCP 工具参数已过期或无法解密，未调用外部工具' }
    let client
    try {
      client = await this.#clients.connect(mcpEndpoint(connection.config), this.#integrations.credential(world.workspaceId, MCP_INTEGRATION_ID))
      const result = await client.callTool(toolName, args)
      return { status: 'executed', detail: summarizeMcpResult(toolName, result) }
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

export function mcpSkillId(toolName: string): string {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized) throw new Error('MCP tool name cannot produce a stable skill id')
  return `mcp.${normalized}`
}

function parseMcpCommand(prompt: string): { toolName: string; arguments: JsonObject } | undefined {
  const match = /^\s*\/mcp\s+([^\s]+)(?:\s+([\s\S]+))?\s*$/i.exec(prompt)
  if (match === null) return undefined
  const toolName = match[1]!
  let value: unknown
  try { value = match[2] === undefined ? {} : JSON.parse(match[2]) }
  catch { throw new ServiceError('invalid', 'mcp_arguments_invalid', 'MCP 工具参数必须是有效的 JSON 对象') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('invalid', 'mcp_arguments_invalid', 'MCP 工具参数必须是 JSON 对象')
  return { toolName, arguments: value as JsonObject }
}

function validateTool(tool: McpToolDefinition): void {
  if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool.name)) throw new Error('MCP tool name is invalid')
  if (JSON.stringify(tool.inputSchema).length > 64_000) throw new Error(`MCP tool schema is too large: ${tool.name}`)
}

function safeToolDescription(tool: McpToolDefinition): string {
  const description = tool.description?.replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
  return description || `由当前工作区 MCP 服务提供的工具 ${tool.name}。调用前需要明确授权。`
}

function summarizeMcpResult(toolName: string, value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `MCP 工具 ${toolName} 已完成；原始结果未持久化`
  const record = value as Record<string, unknown>
  const content = Array.isArray(record.content) ? record.content : []
  const types = content.flatMap((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).type === 'string' ? [(item as Record<string, unknown>).type as string] : [])
  const fields = record.structuredContent !== null && typeof record.structuredContent === 'object' && !Array.isArray(record.structuredContent)
    ? Object.keys(record.structuredContent as Record<string, unknown>).slice(0, 20)
    : []
  return `MCP 工具 ${toolName} 已完成，返回 ${content.length} 个内容块${types.length ? `（${[...new Set(types)].join('、')}）` : ''}${fields.length ? `，结构化字段：${fields.join('、')}` : ''}；原始结果未持久化`
}
