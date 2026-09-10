import { webSearchProviderById, type IntegrationConnection, type WebSearchProviderCatalog, type WebSearchProviderDescriptor } from '@dsh-cyber/contracts'
import { WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV, type WorkerWebSearchPlan } from '@dsh-cyber/harness-adapter'

import { firecrawlBaseUrl, FIRECRAWL_INTEGRATION_ID } from '../integrations/firecrawl-provider.js'
import { WEB_SEARCH_DEFAULT_MARKER, WEB_SEARCH_FALLBACK_PROVIDER, WEB_SEARCH_INTEGRATION_ID } from '../integrations/web-search-provider.js'
import type { IntegrationService } from '../integrations/integration-service.js'

/** The search backend a workspace's built-in `web_search` tool should use. */
export interface ActiveWebSearch {
  /** The owning connection: a 联网搜索 connection, or the legacy Firecrawl one the card took over. */
  connection: IntegrationConnection
  provider: WebSearchProviderDescriptor
  endpoint: string
}

function catalogProvider(catalog: WebSearchProviderCatalog, providerId: string | undefined, fallback: WebSearchProviderDescriptor): WebSearchProviderDescriptor {
  return webSearchProviderById(catalog, providerId) ?? fallback
}

const FIRECRAWL_FALLBACK: WebSearchProviderDescriptor = {
  id: 'firecrawl',
  name: 'Firecrawl',
  description: '网页搜索与抓取服务。',
  endpoint: 'https://api.firecrawl.dev',
  obtain: { text: '前往 Firecrawl 控制台注册并创建 API Key', url: 'https://www.firecrawl.dev/app/sign-up' },
  backend: 'firecrawl',
  integrationId: FIRECRAWL_INTEGRATION_ID,
}

/** A provider id the catalog does not know: kept out of selection entirely. */
const UNKNOWN_FALLBACK: WebSearchProviderDescriptor = {
  id: 'unknown',
  name: '未知服务商',
  description: '',
  endpoint: '',
  obtain: { text: '', url: '' },
  backend: 'unknown',
}

/**
 * Pick the workspace's active 联网搜索 backend. Candidates: enabled
 * 联网搜索 connections (one per catalog provider) plus the legacy Firecrawl
 * connection the 联网搜索 card took over. Selection order: an explicitly
 * marked default, else the first candidate with a configured key, else the
 * first candidate. No candidates at all means web_search is hidden.
 */
export function activeWebSearch(integrations: IntegrationService, workspaceId: string, catalog: WebSearchProviderCatalog): ActiveWebSearch | undefined {
  interface Candidate { connection: IntegrationConnection; provider: WebSearchProviderDescriptor }
  const candidates: Candidate[] = []
  for (const item of integrations.listByType(workspaceId, WEB_SEARCH_INTEGRATION_ID)) {
    if (!item.enabled) continue
    const providerId = typeof item.config.provider === 'string' && item.config.provider ? item.config.provider : WEB_SEARCH_FALLBACK_PROVIDER
    const provider = catalogProvider(catalog, providerId, UNKNOWN_FALLBACK)
    // A catalog entry that declares another integration type (Firecrawl) keeps
    // its key there: a 联网搜索 connection for it is a pre-takeover leftover the
    // cards cannot manage, and it must not silently control routing. Entries
    // without worker wiring cannot serve search either.
    if (provider.integrationId !== undefined && provider.integrationId !== WEB_SEARCH_INTEGRATION_ID) continue
    if (provider.backend !== 'deepseek' && provider.backend !== 'firecrawl') continue
    candidates.push({ connection: item, provider })
  }
  const legacy = integrations.get(workspaceId, FIRECRAWL_INTEGRATION_ID)
  if (legacy !== undefined && legacy.enabled) {
    candidates.push({ connection: legacy, provider: catalogProvider(catalog, 'firecrawl', FIRECRAWL_FALLBACK) })
  }
  if (candidates.length === 0) return undefined
  const hasKey = (connection: IntegrationConnection): boolean => {
    const key = integrations.credentialForConnection(workspaceId, connection.id)
    return key !== undefined && key.trim() !== ''
  }
  const active =
    candidates.find((item) => item.connection.config[WEB_SEARCH_DEFAULT_MARKER] === true)
    ?? candidates.find((item) => hasKey(item.connection))
    ?? candidates[0]
  if (active === undefined) return undefined
  const provider = active.provider
  const endpoint = provider.backend === 'firecrawl'
    ? (active.connection.integrationId === FIRECRAWL_INTEGRATION_ID ? firecrawlBaseUrl(active.connection.config) : provider.endpoint)
    : provider.endpoint
  return { connection: active.connection, provider, endpoint }
}

export interface WebSearchBridge {
  integrations: IntegrationService
  /** The loopback origin the worker calls back into (set once the server listens). */
  hostOrigin(): string | undefined
  /** Per-launch secret shared with spawned workers; never persisted. */
  workerToken: string
  /** The checked-in 联网搜索 provider catalog. */
  catalog(): WebSearchProviderCatalog
}

/**
 * Host-side selection of the worker `web_search` backend, resolved per
 * adapter generation. Model-profile web-search (managed deepseek) outranks
 * this; the router only consults it when the route carries no `webSearch`.
 */
export function resolveWebSearchPlan(bridge: WebSearchBridge, workspaceId: string, route: { webSearch?: unknown } | undefined): WorkerWebSearchPlan | undefined {
  if (route?.webSearch !== undefined) return undefined
  const active = activeWebSearch(bridge.integrations, workspaceId, bridge.catalog())
  if (active === undefined) return { kind: 'disabled' }
  const apiKey = bridge.integrations.credentialForConnection(workspaceId, active.connection.id)
  if (apiKey === undefined || apiKey.trim() === '') return { kind: 'disabled' }
  if (active.provider.backend === 'deepseek') {
    return { kind: 'deepseek', baseUrl: active.endpoint, apiKeyEnv: WORKER_WEBSEARCH_DEEPSEEK_KEY_ENV, apiKey }
  }
  // firecrawl (and any future host-loopback backend): the worker calls back
  // into the host, which holds the credential. No secret crosses the boundary.
  if (active.provider.backend === 'firecrawl') {
    const hostOrigin = bridge.hostOrigin()
    return { kind: 'firecrawl', workspaceId, workerToken: bridge.workerToken, ...(hostOrigin === undefined ? {} : { hostOrigin }) }
  }
  // A catalog entry without worker wiring yet must not silently mis-route:
  // hide the tool rather than point it at a backend that cannot run.
  return { kind: 'disabled' }
}
