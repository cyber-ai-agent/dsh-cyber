import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { WebSearchProviderCatalog, WebSearchProviderDescriptor } from '@dsh-cyber/contracts'

/** The checked-in catalog next to this package is the local source of truth. */
export const DEFAULT_WEB_SEARCH_CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../catalog/web-search-providers.json',
)

/** Built-in fallback when the repository JSON is missing or malformed. */
const FALLBACK_CATALOG: WebSearchProviderCatalog = {
  schemaVersion: 1,
  version: 'built-in',
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      description: 'DeepSeek 官方 Anthropic 兼容端点，驱动模型内置 web_search 工具。',
      endpoint: 'https://api.deepseek.com/anthropic/v1',
      obtain: { text: '前往 DeepSeek 开放平台创建 API Key', url: 'https://platform.deepseek.com/api_keys' },
      backend: 'deepseek',
      dataEgress: ['搜索查询文本', '模型调用用量'],
    },
    {
      id: 'firecrawl',
      name: 'Firecrawl',
      description: '网页搜索与抓取服务；密钥只保存在本机加密凭据库。',
      endpoint: 'https://api.firecrawl.dev',
      obtain: { text: '前往 Firecrawl 控制台注册并创建 API Key', url: 'https://www.firecrawl.dev/app/sign-up' },
      backend: 'firecrawl',
      integrationId: 'builtin.firecrawl',
      dataEgress: ['搜索查询文本'],
    },
  ],
}

export interface WebSearchCatalog {
  catalog(): WebSearchProviderCatalog
}

/**
 * The 联网搜索 provider cards are driven by catalog/web-search-providers.json
 * (checked into the repository, the single extensibility point). DSH_CYBER_WEBSEARCH_CATALOG_PATH
 * can point at another file, or be empty to disable the repository source and
 * use the built-in fallback.
 */
export async function createWebSearchCatalog(options?: { path?: string }): Promise<WebSearchCatalog> {
  const pathOverride = process.env.DSH_CYBER_WEBSEARCH_CATALOG_PATH
  const configuredPath = options?.path ?? (pathOverride === undefined ? DEFAULT_WEB_SEARCH_CATALOG_PATH : pathOverride)
  let catalog = FALLBACK_CATALOG
  if (configuredPath.trim() !== '') {
    try {
      const raw = await readFile(configuredPath, 'utf8')
      catalog = parseWebSearchCatalog(raw, configuredPath)
    } catch {
      catalog = FALLBACK_CATALOG
    }
  }
  return { catalog: () => catalog }
}

export function parseWebSearchCatalog(raw: string, source: string): WebSearchProviderCatalog {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`catalog ${source} is not an object`)
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new Error(`catalog ${source} has an unsupported schemaVersion`)
  if (typeof record.version !== 'string') throw new Error(`catalog ${source} is missing its version`)
  const entries: WebSearchProviderDescriptor[] = []
  const providers = Array.isArray(record.providers) ? record.providers : []
  for (const item of providers) {
    const provider = item as Record<string, unknown>
    if (typeof provider.id !== 'string' || provider.id.trim() === '') throw new Error(`catalog ${source} has a provider without an id`)
    if (typeof provider.name !== 'string') throw new Error(`catalog ${source} provider ${provider.id} is missing its name`)
    if (typeof provider.endpoint !== 'string') throw new Error(`catalog ${source} provider ${provider.id} is missing its endpoint`)
    try {
      new URL(provider.endpoint)
    } catch {
      throw new Error(`catalog ${source} provider ${provider.id} has an invalid endpoint`)
    }
    const obtain = provider.obtain as Record<string, unknown> | undefined
    if (typeof obtain?.url !== 'string') throw new Error(`catalog ${source} provider ${provider.id} is missing its obtain url`)
    entries.push({
      id: provider.id,
      name: provider.name,
      description: typeof provider.description === 'string' ? provider.description : '',
      endpoint: provider.endpoint,
      obtain: {
        text: typeof obtain?.text === 'string' ? obtain.text : '获取 API 密钥',
        url: obtain.url,
      },
      backend: provider.backend === 'deepseek' || provider.backend === 'firecrawl' ? provider.backend : 'unknown',
      ...(typeof provider.integrationId === 'string' ? { integrationId: provider.integrationId } : {}),
      ...(Array.isArray(provider.dataEgress) ? { dataEgress: (provider.dataEgress as unknown[]).map(String) } : {}),
    })
  }
  if (entries.length === 0) throw new Error(`catalog ${source} declares no providers`)
  return { schemaVersion: 1, version: record.version, providers: entries }
}
