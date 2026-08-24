import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

import type { IntegrationProvider, IntegrationProviderContext } from './integration-registry.js'
import type { McpClientFactory } from './mcp-client.js'
import { normalizeIntegrationBaseUrl } from './firecrawl-provider.js'

export const MCP_INTEGRATION_ID = 'builtin.mcp'

const DESCRIPTOR: IntegrationDescriptor = {
  id: MCP_INTEGRATION_ID,
  displayName: 'MCP 工具服务器',
  summary: '通过 Streamable HTTP 发现并调用 MCP 工具。每个工具仍需角色授权和逐动作审批。',
  configFields: [{ id: 'endpoint', displayName: 'MCP 地址', description: '完整的 Streamable HTTP MCP 地址；公网必须使用 HTTPS。', kind: 'url', required: true, placeholder: 'http://127.0.0.1:3000/mcp' }],
  secretFields: [{ id: 'bearerToken', displayName: 'Bearer Token', description: '可选，仅在本机加密凭据库保存，保存后不回显。', kind: 'secret', required: false }],
  skillIds: [],
  dataEgress: ['所批准工具调用的结构化参数'],
}

export class McpIntegrationProvider implements IntegrationProvider {
  readonly descriptor = DESCRIPTOR
  readonly #clients: McpClientFactory

  constructor(clients: McpClientFactory) { this.#clients = clients }

  validateConfig(config: JsonObject): JsonObject {
    if (typeof config.endpoint !== 'string' || !config.endpoint.trim()) throw new Error('MCP 地址不能为空')
    const endpoint = normalizeIntegrationBaseUrl(config.endpoint.trim())
    return { endpoint }
  }

  async testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth> {
    const startedAt = Date.now()
    let client
    try {
      const endpoint = String(this.validateConfig(context.config).endpoint)
      client = await this.#clients.connect(endpoint, context.credential)
      const tools = await client.listTools()
      return { status: 'ready', detail: `连接成功，发现 ${tools.length} 个工具`, checkedAt: context.now.toISOString(), latencyMs: Date.now() - startedAt }
    } catch {
      return { status: 'unreachable', detail: '无法连接 MCP 服务或读取工具目录', checkedAt: context.now.toISOString(), latencyMs: Date.now() - startedAt }
    } finally { await client?.close().catch(() => undefined) }
  }
}

export function mcpEndpoint(config: JsonObject): string {
  if (typeof config.endpoint !== 'string') throw new Error('MCP 地址未配置')
  return normalizeIntegrationBaseUrl(config.endpoint)
}
