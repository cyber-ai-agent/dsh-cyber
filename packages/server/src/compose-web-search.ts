import { randomBytes } from 'node:crypto'

import type { AgentTurnRequest } from '@dsh-cyber/contracts'

import type { Router } from './http/router.js'
import type { IntegrationService } from './integrations/integration-service.js'
import { registerWebSearchRoutes } from './routes/web-search-routes.js'
import { resolveWebSearchPlan, type WebSearchBridge } from './services/web-search-bridge.js'
import type { HarnessModelRoute } from '@dsh-cyber/harness-adapter'
import { createWebSearchCatalog, type WebSearchCatalog } from './web-search-catalog.js'

export interface WebSearchWiring {
  /** Register the 联网搜索 routes (worker bridge + provider catalog) on the app router. */
  register(router: Router): void
  /** The router option callback: resolve the worker `web_search` plan for a turn. */
  resolveWebSearchPlan(request: AgentTurnRequest, route: HarnessModelRoute | undefined): ReturnType<typeof resolveWebSearchPlan>
}

/**
 * Composition root for the 联网搜索 host bridge. Kept out of server.ts (the
 * 600-line architecture budget). Workers call back over loopback with a
 * per-launch token; the Firecrawl credential stays host-side. `originProvider`
 * is read lazily so the loopback origin (known only after the server listens)
 * can be supplied without a second wiring step. The provider catalog is the
 * checked-in catalog/web-search-providers.json.
 */
export async function createWebSearchWiring(
  integrations: IntegrationService,
  originProvider?: () => string | undefined,
  connectionGrantsFor?: (characterId: string) => readonly string[] | undefined,
): Promise<WebSearchWiring> {
  const catalogSource = await createWebSearchCatalog()
  const catalog: WebSearchCatalog = catalogSource
  const bridge: WebSearchBridge = {
    integrations,
    workerToken: randomBytes(32).toString('hex'),
    hostOrigin: () => originProvider?.(),
    catalog: () => catalog.catalog(),
  }
  return {
    register(router: Router): void {
      registerWebSearchRoutes(router, { integrations, workerToken: bridge.workerToken, catalog: () => catalog.catalog() })
    },
    resolveWebSearchPlan(request, route): ReturnType<typeof resolveWebSearchPlan> {
      if (!request.revision.skillGrants.includes('web.search.firecrawl')) return { kind: 'disabled' }
      return resolveWebSearchPlan(bridge, request.agent.workspaceId, route, connectionGrantsFor?.(request.agent.id) ?? [])
    },
  }
}
