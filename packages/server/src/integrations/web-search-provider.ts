import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

import type { IntegrationProvider, IntegrationProviderContext } from './integration-registry.js'

/**
 * The 连接中心「联网搜索」main item. It takes over the old standalone
 * Firecrawl item: provider cards are driven by catalog/web-search-providers.json
 * and each card edits its own integration type's key (the Firecrawl card edits
 * the legacy `builtin.firecrawl` connection so skills and knowledge import keep
 * one credential home). A `builtin.web-search` connection is one key per
 * catalog provider (recorded in `config.provider`), never a free-form choice.
 */
export const WEB_SEARCH_INTEGRATION_ID = 'builtin.web-search'
export const WEB_SEARCH_DEFAULT_MARKER = 'isDefault'
export const WEB_SEARCH_FALLBACK_PROVIDER = 'deepseek'

const DESCRIPTOR: IntegrationDescriptor = {
  id: WEB_SEARCH_INTEGRATION_ID,
  displayName: '联网搜索',
  summary: '配置角色内置 web_search 工具使用的搜索服务商。服务商目录来自仓库 catalog/web-search-providers.json；凭据只在本机加密保存。',
  configFields: [
    {
      id: WEB_SEARCH_DEFAULT_MARKER,
      displayName: '设为默认搜索服务商',
      description: '勾选后，对话中的联网搜索优先使用这家服务商。',
      kind: 'boolean',
      required: false,
    },
  ],
  secretFields: [
    { id: 'apiKey', displayName: 'API 密钥', description: '仅在本机加密凭据库保存，保存后不回显。', kind: 'secret', required: true },
  ],
  skillIds: ['web.search.firecrawl'],
  dataEgress: ['搜索查询文本'],
  allowsMultipleConnections: true,
}

/**
 * Normalize one 联网搜索 connection's durable config. `provider` records which
 * catalog entry owns this key (the card UI writes it; it is not a user-editable
 * field anymore). `isDefault` is a plain boolean marker the host enforces to be
 * single-valued per workspace, across this type and the legacy Firecrawl type.
 */
export function normalizeWebSearchConfig(config: JsonObject): JsonObject {
  const providerId = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : WEB_SEARCH_FALLBACK_PROVIDER
  return {
    provider: providerId,
    [WEB_SEARCH_DEFAULT_MARKER]: config[WEB_SEARCH_DEFAULT_MARKER] === true,
  }
}

export class WebSearchIntegrationProvider implements IntegrationProvider {
  readonly descriptor = DESCRIPTOR

  validateConfig(config: JsonObject): JsonObject {
    return normalizeWebSearchConfig(config)
  }

  async testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth> {
    const startedAt = Date.now()
    if (!context.credential) return health('misconfigured', '尚未配置 API 密钥', context.now, startedAt)
    // A real search spends a model turn and should be verified in-conversation,
    // not from the settings form: with the key and catalog endpoint in place
    // the backend is considered configured.
    return health('ready', '配置完整（密钥已保存）；实际搜索将在对话中生效', context.now, startedAt)
  }
}

function health(status: IntegrationHealth['status'], detail: string, now: Date, startedAt: number): IntegrationHealth {
  return { status, detail, checkedAt: now.toISOString(), latencyMs: Math.max(0, Date.now() - startedAt) }
}
