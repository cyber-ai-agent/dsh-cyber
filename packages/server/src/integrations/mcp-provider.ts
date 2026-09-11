import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

import type { IntegrationProvider, IntegrationProviderContext } from './integration-registry.js'
import type { McpClientFactory, McpConnectSpec } from './mcp-client.js'
import { normalizeIntegrationBaseUrl } from './firecrawl-provider.js'

export const MCP_INTEGRATION_ID = 'builtin.mcp'
/** Service slug a connection created before multi-service support is backfilled with on load. */
export const MCP_LEGACY_SERVICE_SLUG = 'default'
/** Execution mode a connection created before dual-mode support is backfilled with on load. */
export const MCP_LEGACY_MODE = 'remote'

const DESCRIPTOR: IntegrationDescriptor = {
  id: MCP_INTEGRATION_ID,
  displayName: 'MCP 连接',
  summary: '接入一个或多个 MCP 服务：远程模式连接已有 MCP 服务地址（可选 Bearer 凭据），本机模式由应用直接拉起本地 MCP 进程。每个服务的工具按「服务标识」命名空间映射为独立技能，仍需角色授权与逐动作审批。',
  configFields: [
    { id: 'service', displayName: '服务标识', description: '短小写标识（字母/数字/连字符），用于技能 ID mcp.<标识>.<工具> 与 /mcp 命令；同一工作区内须唯一。', kind: 'text', required: true, placeholder: 'github' },
    {
      id: 'mode',
      displayName: '运行模式',
      description: '远程：连接一个已在运行的 MCP 服务地址；本机：由应用按命令拉起本地 MCP 进程并通过 stdio 通信。',
      kind: 'select',
      required: true,
      options: ['remote', 'local'],
      optionLabels: { remote: '远程服务地址', local: '本机进程（应用拉起）' },
      placeholder: 'remote',
    },
    {
      id: 'endpoint',
      displayName: 'MCP 地址',
      description: '远程模式必填：完整的 Streamable HTTP MCP 地址；公网必须使用 HTTPS。',
      kind: 'url',
      required: true,
      placeholder: 'http://127.0.0.1:8931/mcp',
      visibleWhen: { field: 'mode', equals: ['remote'] },
    },
    {
      id: 'command',
      displayName: '启动命令',
      description: '本机模式必填：MCP 服务的可执行文件，如 npx 或 node（无 Shell 语法）。',
      kind: 'text',
      required: false,
      placeholder: 'npx',
      visibleWhen: { field: 'mode', equals: ['local'] },
    },
    {
      id: 'args',
      displayName: '命令参数',
      description: '本机模式可选：空格分隔的参数列表，如 "@playwright/mcp@latest --port 8931"。',
      kind: 'text',
      required: false,
      placeholder: '@playwright/mcp@latest',
      visibleWhen: { field: 'mode', equals: ['local'] },
    },
    { id: 'displayName', displayName: '连接名称', description: '可选，用于在连接列表中区分多个 MCP 服务。', kind: 'text', required: false, placeholder: 'GitHub MCP' },
  ],
  secretFields: [{ id: 'bearerToken', displayName: 'Bearer Token', description: '可选，仅远程模式使用；在本机加密凭据库保存，保存后不回显。', kind: 'secret', required: false }],
  skillIds: [],
  dataEgress: ['所批准工具调用的结构化参数'],
  allowsMultipleConnections: true,
}

export class McpIntegrationProvider implements IntegrationProvider {
  readonly descriptor = DESCRIPTOR
  readonly #clients: McpClientFactory

  constructor(clients: McpClientFactory) { this.#clients = clients }

  validateConfig(config: JsonObject): JsonObject {
    const service = mcpServiceSlug(config)
    const mode = mcpMode(config)
    const displayName = typeof config.displayName === 'string' ? config.displayName.trim().slice(0, 80) : ''
    if (mode === 'local') {
      const command = mcpLocalCommand(config)
      const args = normalizeMcpLocalArgs(config)
      return { service, mode, command, args, ...(displayName === '' ? {} : { displayName }) }
    }
    const endpoint = mcpEndpoint(config)
    return { service, mode, endpoint, ...(displayName === '' ? {} : { displayName }) }
  }

  async testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth> {
    const startedAt = Date.now()
    let client
    try {
      const spec = mcpConnectSpecFor(context.config, context.credential)
      client = await this.#clients.connect(spec)
      const tools = await client.listTools()
      return { status: 'ready', detail: `连接成功，发现 ${tools.length} 个工具`, checkedAt: context.now.toISOString(), latencyMs: Date.now() - startedAt }
    } catch {
      return { status: 'unreachable', detail: '无法连接 MCP 服务或读取工具目录', checkedAt: context.now.toISOString(), latencyMs: Date.now() - startedAt }
    } finally { await client?.close().catch(() => undefined) }
  }
}

/**
 * The service slug that namespaces this connection's skills and `/mcp`
 * commands. A missing slug (a connection created before multi-service
 * support) backfills to `default` so loading legacy connections never throws;
 * a present slug must normalize to a valid identifier.
 */
/** Normalize an identifier to a service slug (`[a-z0-9-]`, ≤48 chars). Throws when nothing remains. */
export function normalizeMcpServiceSlug(value: string): string {
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('MCP 服务标识不能为空')
  if (slug.length > 48) throw new Error('MCP 服务标识过长（最多 48 个字符）')
  return slug
}

/**
 * The service slug that namespaces this connection's skills and `/mcp`
 * commands. A missing slug (a connection created before multi-service
 * support) backfills to `default` so loading legacy connections never throws;
 * a present slug must normalize to a valid identifier.
 */
export function mcpServiceSlug(config: JsonObject): string {
  if (config.service === undefined) return MCP_LEGACY_SERVICE_SLUG
  return normalizeMcpServiceSlug(String(config.service))
}

/**
 * Execution mode of a connection. A missing or unknown mode backfills to
 * `remote`, which is exactly what every pre-dual-mode connection was.
 */
export function mcpMode(config: JsonObject): 'remote' | 'local' {
  return config.mode === 'local' ? 'local' : MCP_LEGACY_MODE
}

export function mcpEndpoint(config: JsonObject): string {
  if (typeof config.endpoint !== 'string') throw new Error('MCP 地址未配置')
  return normalizeIntegrationBaseUrl(config.endpoint)
}

/** The local executable that launches the MCP server (machine executable name or path, no shell syntax). */
export function mcpLocalCommand(config: JsonObject): string {
  const value = typeof config.command === 'string' ? config.command.trim() : ''
  if (!value) throw new Error('本机 MCP 启动命令未配置')
  if (value.length > 200) throw new Error('本机 MCP 启动命令过长')
  assertNoShellSyntax(value, '本机 MCP 启动命令')
  return value
}

/**
 * The local argument list, normalized to one collapsed-whitespace string that
 * the form and the config store can both round-trip. Empty is a legal value
 * (an MCP server with no arguments); tokens are checked for shell syntax so
 * the value is always a plain executable + argument vector.
 */
export function normalizeMcpLocalArgs(config: JsonObject): string {
  const raw = typeof config.args === 'string' ? config.args : Array.isArray(config.args) ? config.args.join(' ') : ''
  const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length > 16) throw new Error('本机 MCP 命令参数过多（最多 16 项）')
  for (const token of tokens) {
    if (token.length > 200) throw new Error('本机 MCP 单个参数过长')
    assertNoShellSyntax(token, '本机 MCP 命令参数')
  }
  return tokens.join(' ')
}

/** Split a normalized local args string into the spawn argv. */
export function mcpLocalArgs(config: JsonObject): string[] {
  return normalizeMcpLocalArgs(config).length === 0 ? [] : normalizeMcpLocalArgs(config).split(' ')
}

const SHELL_SYNTAX = /[&;|<>"'`\n\r]/

function assertNoShellSyntax(value: string, label: string): void {
  if (SHELL_SYNTAX.test(value)) throw new Error(`${label}不得包含 Shell 元字符`)
}

/** The connection spec handed to the client factory, by execution mode. */
export function mcpConnectSpec(config: JsonObject): McpConnectSpec {
  if (mcpMode(config) === 'local') {
    return { kind: 'local', command: mcpLocalCommand(config), args: mcpLocalArgs(config) }
  }
  return { kind: 'remote', endpoint: mcpEndpoint(config) }
}

/**
 * The spec with the connection's stored bearer credential attached. Local
 * specs never carry a credential: the launched process authenticates with
 * whatever the user configured on that machine.
 */
export function mcpConnectSpecFor(config: JsonObject, credential?: string): McpConnectSpec {
  const spec = mcpConnectSpec(config)
  if (spec.kind === 'local' || credential === undefined) return spec
  return { ...spec, bearerToken: credential }
}
