import { describe, expect, it } from 'vitest'
import type { IntegrationConnection } from '@dsh-cyber/contracts'

import { FIRECRAWL_INTEGRATION_ID } from '../src/integrations/firecrawl-provider.js'
import type { IntegrationService } from '../src/integrations/integration-service.js'
import { WEB_SEARCH_DEFAULT_MARKER, WEB_SEARCH_INTEGRATION_ID } from '../src/integrations/web-search-provider.js'
import { activeWebSearch, resolveWebSearchPlan, type WebSearchBridge } from '../src/services/web-search-bridge.js'
import { TEST_CATALOG } from './web-search-test-catalog.js'

interface WebSearchConnectionOptions {
  id?: string
  provider?: string
  isDefault?: boolean
  enabled?: boolean
}

function webSearchConnection(options: WebSearchConnectionOptions = {}): IntegrationConnection {
  const now = new Date().toISOString()
  return {
    id: options.id ?? 'conn-1',
    workspaceId: 'ws-1',
    integrationId: WEB_SEARCH_INTEGRATION_ID,
    displayName: '联网搜索',
    config: {
      provider: options.provider ?? 'deepseek',
      [WEB_SEARCH_DEFAULT_MARKER]: options.isDefault === true,
    },
    enabled: options.enabled ?? true,
    credentialConfigured: false,
    createdAt: now,
    updatedAt: now,
  }
}

function legacyFirecrawlConnection(options: WebSearchConnectionOptions & { baseUrl?: string } = {}): IntegrationConnection {
  const now = new Date().toISOString()
  return {
    id: options.id ?? 'fc-legacy',
    workspaceId: 'ws-1',
    integrationId: FIRECRAWL_INTEGRATION_ID,
    displayName: 'Firecrawl',
    config: {
      baseUrl: options.baseUrl ?? '',
      [WEB_SEARCH_DEFAULT_MARKER]: options.isDefault === true,
    },
    enabled: options.enabled ?? true,
    credentialConfigured: false,
    createdAt: now,
    updatedAt: now,
  }
}

function stubIntegrations(options: {
  webSearch?: IntegrationConnection[]
  legacyFirecrawl?: IntegrationConnection
  credentials?: Record<string, string | undefined>
}): IntegrationService {
  const { webSearch = [], legacyFirecrawl, credentials = {} } = options
  return {
    listByType: (_workspaceId: string, integrationId: string) => (integrationId === WEB_SEARCH_INTEGRATION_ID ? webSearch : []),
    get: (_workspaceId: string, integrationId: string) => (integrationId === FIRECRAWL_INTEGRATION_ID ? legacyFirecrawl : undefined),
    credentialForConnection: (_workspaceId: string, connectionId: string) => credentials[connectionId],
  } as unknown as IntegrationService
}

function bridge(integrations: IntegrationService, hostOrigin?: string): WebSearchBridge {
  return {
    integrations,
    workerToken: 'tok',
    hostOrigin: () => hostOrigin,
    catalog: () => TEST_CATALOG,
  }
}

describe('activeWebSearch', () => {
  it('prefers an explicitly marked default across both connection types', () => {
    const web = webSearchConnection({ id: 'a', provider: 'deepseek' })
    const legacy = legacyFirecrawlConnection({ id: 'f', isDefault: true })
    const integrations = stubIntegrations({ webSearch: [web], legacyFirecrawl: legacy })
    expect(activeWebSearch(integrations, 'ws-1', TEST_CATALOG)?.connection.id).toBe('f')
  })

  it('falls back to the first candidate with a configured key', () => {
    const keyless = webSearchConnection({ id: 'a', provider: 'deepseek' })
    const legacy = legacyFirecrawlConnection({ id: 'f' })
    const integrations = stubIntegrations({ webSearch: [keyless], legacyFirecrawl: legacy, credentials: { f: 'sk-x' } })
    expect(activeWebSearch(integrations, 'ws-1', TEST_CATALOG)?.connection.id).toBe('f')
  })

  it('ignores disabled connections and disabled legacy connections', () => {
    const off = webSearchConnection({ id: 'a', provider: 'deepseek', enabled: false })
    const legacyOff = legacyFirecrawlConnection({ id: 'f', enabled: false })
    expect(activeWebSearch(stubIntegrations({ webSearch: [off], legacyFirecrawl: legacyOff }), 'ws-1', TEST_CATALOG)).toBeUndefined()
  })

  it('ignores a pre-takeover 联网搜索 connection for a provider owned by another integration type', () => {
    // The Firecrawl card edits the legacy connection; a 联网搜索 connection
    // claiming firecrawl is unmanageable leftover and must not control routing.
    const orphan = webSearchConnection({ id: 'orphan', provider: 'firecrawl', isDefault: true })
    const legacy = legacyFirecrawlConnection({ id: 'f' })
    const integrations = stubIntegrations({ webSearch: [orphan], legacyFirecrawl: legacy, credentials: { f: 'sk-x' } })
    expect(activeWebSearch(integrations, 'ws-1', TEST_CATALOG)?.connection.id).toBe('f')
    expect(activeWebSearch(stubIntegrations({ webSearch: [orphan], credentials: { orphan: 'sk-y' } }), 'ws-1', TEST_CATALOG)).toBeUndefined()
  })
})

describe('resolveWebSearchPlan', () => {
  it('defers to the model profile when it carries a managed webSearch', () => {
    expect(resolveWebSearchPlan(bridge(stubIntegrations({})), 'ws-1', { webSearch: { baseURL: 'x', apiKeyEnv: 'y' } })).toBeUndefined()
  })

  it('returns disabled when no 联网搜索 backend is usable', () => {
    expect(resolveWebSearchPlan(bridge(stubIntegrations({})), 'ws-1', undefined)).toEqual({ kind: 'disabled' })
  })

  it('selects the DeepSeek backend and carries its key', () => {
    const conn = webSearchConnection({ id: 'a', provider: 'deepseek' })
    const plan = resolveWebSearchPlan(bridge(stubIntegrations({ webSearch: [conn], credentials: { a: 'sk-x' } }), 'http://127.0.0.1:43123'), 'ws-1', undefined)
    expect(plan).toMatchObject({ kind: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic/v1', apiKey: 'sk-x' })
  })

  it('downgrades a DeepSeek connection without a key to disabled', () => {
    const conn = webSearchConnection({ id: 'a', provider: 'deepseek' })
    expect(resolveWebSearchPlan(bridge(stubIntegrations({ webSearch: [conn] })), 'ws-1', undefined)).toEqual({ kind: 'disabled' })
  })

  it('routes Firecrawl through the host loopback without leaking the key (legacy connection)', () => {
    const legacy = legacyFirecrawlConnection({ id: 'f', baseUrl: 'https://fc.example' })
    const plan = resolveWebSearchPlan(bridge(stubIntegrations({ legacyFirecrawl: legacy, credentials: { f: 'sk-secret' } }), 'http://127.0.0.1:43123'), 'ws-1', undefined)
    expect(plan).toMatchObject({ kind: 'firecrawl', workspaceId: 'ws-1', hostOrigin: 'http://127.0.0.1:43123', workerToken: 'tok' })
    expect(JSON.stringify(plan)).not.toContain('sk-secret')
  })
})
