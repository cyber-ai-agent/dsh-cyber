import { BUILTIN_BLUEPRINTS, BUILTIN_WORLD_TEMPLATES } from '@dsh-cyber/catalog'
import type { CyberMarketKind } from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import { writeJson } from '../http/response.js'
import { loadInstalledBlueprints } from '../installed-package-runtime.js'

export interface CatalogRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
}

export function registerCatalogRoutes(router: Router, dependencies: CatalogRoutesDependencies): void {
  const { store, packageCatalog } = dependencies

  router.get('/api/catalog/world-templates', ({ response }) => {
    writeJson(response, 200, { items: BUILTIN_WORLD_TEMPLATES })
  })

  router.get('/api/catalog/blueprints', async ({ response, url }) => {
    const templateId = url.searchParams.get('templateId')
    const runtimeTemplateId = templateId === 'personal-world' ? 'cyber-company' : templateId
    const workspaceId = url.searchParams.get('workspaceId')
    const installed = workspaceId === null ? [] : store.listInstalledPackages(workspaceId)
    const packageBlueprints = await loadInstalledBlueprints(installed)
    for (const blueprint of packageBlueprints) store.saveBlueprint(blueprint)
    const available = [...BUILTIN_BLUEPRINTS, ...packageBlueprints]
    const items = runtimeTemplateId
      ? available.filter((item) => item.worldTemplateId === runtimeTemplateId)
      : available
    writeJson(response, 200, { items })
  })

  router.get('/api/marketplace', async ({ response, url }) => {
    const market = url.searchParams.get('market')
    if (market !== null && !['theme', 'plugin', 'talent'].includes(market)) {
      throw new HttpError(422, 'invalid_market', 'Unknown marketplace')
    }
    const workspaceId = url.searchParams.get('workspaceId')
    const installed = workspaceId === null ? [] : store.listInstalledPackages(workspaceId)
    const items = await packageCatalog.list({
      ...(market === null ? {} : { market: market as CyberMarketKind }),
      ...(url.searchParams.get('q') === null ? {} : { query: url.searchParams.get('q')! }),
      installed,
    })
    writeJson(response, 200, { items })
  })
}
