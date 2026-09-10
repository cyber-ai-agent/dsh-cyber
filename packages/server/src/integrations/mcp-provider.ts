import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

import type { IntegrationProvider, IntegrationProviderContext } from './integration-registry.js'
import type { McpClientFactory } from './mcp-client.js'
import { normalizeIntegrationBaseUrl } from './firecrawl-provider.js'

export const MCP_INTEGRATION_ID = 'builtin.mcp'
/** Service slug a connection created before multi-service support is backfilled with on load. */
export const MCP_LEGACY_SERVICE_SLUG = 'default'

const DESCRIPTOR: IntegrationDescriptor = {
  id: MCP_INTEGRATION_ID,
  displayName: 'MCP 连接',
  summary: '通过 Streamable HTTP 添加并调用多个 MCP 服务。每个服务的工具按「服务标识」命名空间映射为独立技能，仍需角色授权与逐动作审批。',
  configFields: [
    { id: 'service', displayName: '服务标识', description: '短小写标识（字母/数字/连字符），用于技能 ID mcp.<标识>.<工具> 与 /mcp 命令；同一工作区内须唯一。', kind: 'text', required: true, placeholder: 'github' },
    { id: 'endpoint', displayName: 'MCP 地址', description: '完整的 Streamable HTTP MCP 地址；公网必须使用 HTTPS。', kind: 'url', required: true, placeholder: 'http://127.0.0.1:3000/mcp' },
    { id: 'displayName', displayName: '连接名称', description: '可选，用于在连接列表中区分多个 MCP 服务。', kind: 'text', required: false, placeholder: 'GitHub MCP' },
  ],
  secretFields: [{ id: 'bearerToken', displayName: 'Bearer Token', description: '可选，仅在本机加密凭据库保存，保存后不回显。', kind: 'secret', required: false }],
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
    const endpoint = mcpEndpoint(config)
    const displayName = typeof config.displayName === 'string' ? config.displayName.trim().slice(0, 80) : ''
    return { service, endpoint, ...(displayName === '' ? {} : { displayName }) }
  }

  async testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth> {
    const startedAt = Date.now()
    let client
    try {
      const endpoint = mcpEndpoint(context.config)
      client = await this.#clients.connect(endpoint, context.credential)
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

export function mcpEndpoint(config: JsonObject): string {
  if (typeof config.endpoint !== 'string') throw new Error('MCP 地址未配置')
  return normalizeIntegrationBaseUrl(config.endpoint)
}
