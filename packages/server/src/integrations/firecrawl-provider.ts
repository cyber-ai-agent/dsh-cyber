import type { IntegrationDescriptor, IntegrationHealth, JsonObject } from '@dsh-cyber/contracts'

import type { IntegrationProvider, IntegrationProviderContext } from './integration-registry.js'

export const FIRECRAWL_INTEGRATION_ID = 'builtin.firecrawl'
export const FIRECRAWL_DEFAULT_BASE_URL = 'https://api.firecrawl.dev'

const DESCRIPTOR: IntegrationDescriptor = {
  id: FIRECRAWL_INTEGRATION_ID,
  displayName: 'Firecrawl',
  summary: '受信任的网页搜索连接。查询内容会发送到所配置的 Firecrawl 服务。',
  configFields: [{ id: 'baseUrl', displayName: '服务地址', description: 'Firecrawl 云端或自托管服务根地址。', kind: 'url', required: true, placeholder: FIRECRAWL_DEFAULT_BASE_URL }],
  secretFields: [{ id: 'apiKey', displayName: 'API 密钥', description: '仅在本机加密凭据库保存，保存后不回显。', kind: 'secret', required: true }],
  skillIds: ['web.search.firecrawl'],
  dataEgress: ['搜索查询文本', '用户明确提供的检索范围'],
}

export class FirecrawlIntegrationProvider implements IntegrationProvider {
  readonly descriptor = DESCRIPTOR

  validateConfig(config: JsonObject): JsonObject {
    const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : FIRECRAWL_DEFAULT_BASE_URL
    return { baseUrl: normalizeIntegrationBaseUrl(baseUrl) }
  }

  async testConnection(context: IntegrationProviderContext): Promise<IntegrationHealth> {
    const startedAt = Date.now()
    if (!context.credential) return health('misconfigured', '尚未配置 API 密钥', context.now, startedAt)
    const baseUrl = String(this.validateConfig(context.config).baseUrl)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await context.fetch(`${baseUrl}/v2/team/activity?limit=1`, { headers: { Authorization: `Bearer ${context.credential}` }, signal: controller.signal })
      if (response.ok) return health('ready', '连接测试成功', context.now, startedAt)
      if (response.status === 401 || response.status === 403) return health('misconfigured', 'API 密钥无效或没有访问权限', context.now, startedAt)
      return health('unreachable', `服务返回 HTTP ${response.status}`, context.now, startedAt)
    } catch (error) {
      return health('unreachable', error instanceof Error && error.name === 'AbortError' ? '连接测试超时' : '无法连接 Firecrawl 服务', context.now, startedAt)
    } finally { clearTimeout(timeout) }
  }
}

export function firecrawlBaseUrl(config: JsonObject): string {
  const value = typeof config.baseUrl === 'string' ? config.baseUrl : FIRECRAWL_DEFAULT_BASE_URL
  return normalizeIntegrationBaseUrl(value)
}

function health(status: IntegrationHealth['status'], detail: string, now: Date, startedAt: number): IntegrationHealth {
  return { status, detail, checkedAt: now.toISOString(), latencyMs: Math.max(0, Date.now() - startedAt) }
}

export function normalizeIntegrationBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Integration base URL is invalid') }
  if (url.username || url.password || url.hash || url.search) throw new Error('Integration base URL must not contain credentials, query or fragment')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) {
    throw new Error('Public integration endpoints must use HTTPS')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function isPrivateHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 === null) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  const octets = ipv4.slice(1).map(Number); const [first, second] = octets
  return !octets.some((item) => item > 255) && (first === 10 || first === 127 || (first === 172 && second !== undefined && second >= 16 && second <= 31) || (first === 192 && second === 168))
}
