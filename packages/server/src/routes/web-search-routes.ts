import { WEB_SEARCH_WORKER_TOKEN_HEADER, type WebSearchProviderCatalog } from '@dsh-cyber/contracts'

import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import { optionalPositiveInteger, readJson, record, requiredString, headerValue } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { firecrawlSearchDirect, FirecrawlClientError } from '../integrations/firecrawl-client.js'
import { activeWebSearch } from '../services/web-search-bridge.js'
import type { IntegrationService } from '../integrations/integration-service.js'

export interface WebSearchRoutesDependencies {
  integrations: IntegrationService
  /** Per-launch worker secret; the route refuses anything else. */
  workerToken: string
  /** The checked-in 联网搜索 provider catalog (served to the UI, used by the worker route). */
  catalog(): WebSearchProviderCatalog
  /** Injectable transport (tests stub the Firecrawl call). */
  fetch?: typeof globalThis.fetch
}

/**
 * 联网搜索 routes. The DSH worker's firecrawl provider calls the search bridge
 * over loopback; the Firecrawl credential itself stays host-side. Auth is the
 * per-launch worker token (a capability, not a user credential), so the
 * endpoint is safe even while the app lock is engaged — no active turn (and
 * thus no worker) exists while locked. The GET route serves the checked-in
 * provider catalog so the 联网搜索 cards render fixed providers, not a free
 * dropdown.
 */
export function registerWebSearchRoutes(router: Router, dependencies: WebSearchRoutesDependencies): void {
  const { integrations, workerToken, catalog } = dependencies
  const fetchImpl = dependencies.fetch
  router.get('/api/integrations/web-search/providers', ({ response }) => {
    writeJson(response, 200, { catalog: catalog() })
  })
  router.post('/api/integrations/firecrawl/search', async ({ request, response }) => {
    const token = headerValue(request.headers[WEB_SEARCH_WORKER_TOKEN_HEADER])
    if (token !== workerToken) throw new HttpError(401, 'web_search_worker_unauthorized', 'worker 鉴权失败')
    const body = record(await readJson(request)) ?? {}
    const workspaceId = requiredString(body, 'workspaceId')
    const query = requiredString(body, 'query')
    const limit = optionalPositiveInteger(body.limit) ?? 5

    const active = activeWebSearch(integrations, workspaceId, catalog())
    if (active === undefined || active.provider.backend !== 'firecrawl') {
      throw new HttpError(409, 'web_search_not_configured', '当前工作区没有可用的 Firecrawl 联网搜索连接')
    }
    const apiKey = integrations.credentialForConnection(workspaceId, active.connection.id)
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new HttpError(409, 'web_search_not_configured', 'Firecrawl 联网搜索连接缺少 API 密钥')
    }
    let items
    try {
      items = await firecrawlSearchDirect({
        baseUrl: active.endpoint,
        apiKey,
        query,
        limit,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
    } catch (error) {
      if (error instanceof FirecrawlClientError) {
        throw new HttpError(422, 'web_search_provider_failed', error.message)
      }
      throw new HttpError(502, 'web_search_provider_failed', error instanceof Error ? error.message : 'Firecrawl 搜索失败')
    }
    writeJson(response, 200, {
      sources: items.map((item) => ({
        url: item.url,
        title: item.title,
        ...(item.description === undefined ? {} : { snippet: item.description }),
      })),
      truncated: items.length >= limit,
    })
  })
}
