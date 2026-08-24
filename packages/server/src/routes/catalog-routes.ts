import { BUILTIN_BLUEPRINTS, BUILTIN_WORLD_TEMPLATES } from '@dsh-cyber/catalog'
import { BUILTIN_EMBODIMENT_PRESETS } from '@dsh-cyber/catalog/creative'
import type { CyberMarketActivation, CyberMarketKind, CyberMarketPackage } from '@dsh-cyber/contracts'
import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import type { LocalPackageCatalog } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { validateWorldThemeManifest } from '@dsh-cyber/world-runtime'

import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import { writeBinary, writeJson } from '../http/response.js'
import { loadInstalledBlueprints } from '../installed-package-runtime.js'
import { parseEmployeeBlueprintManifest } from '../employee-blueprint-manifest.js'
import { parsePromptTransformDefinition } from '../prompt-transform-parser.js'

export interface CatalogRoutesDependencies {
  store: SqliteStore
  packageCatalog: LocalPackageCatalog
}

export function registerCatalogRoutes(router: Router, dependencies: CatalogRoutesDependencies): void {
  const { store, packageCatalog } = dependencies

  router.get('/api/catalog/world-templates', ({ response }) => {
    writeJson(response, 200, { items: BUILTIN_WORLD_TEMPLATES })
  })

  router.get('/api/catalog/embodiment-presets', ({ response }) => {
    writeJson(response, 200, { items: BUILTIN_EMBODIMENT_PRESETS })
  })

  router.get('/api/catalog/blueprints', async ({ response, url }) => {
    const templateId = url.searchParams.get('templateId')
    const workspaceId = url.searchParams.get('workspaceId')
    const installed = workspaceId === null ? [] : store.listInstalledPackages(workspaceId)
    const packageBlueprints = await loadInstalledBlueprints(installed)
    for (const blueprint of packageBlueprints) store.saveBlueprint(blueprint)
    const available = [...BUILTIN_BLUEPRINTS, ...packageBlueprints]
    const items = templateId === 'personal-world'
      ? available
      : templateId
        ? available.filter((item) => item.worldTemplateId === templateId)
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
    const catalogItems = await packageCatalog.list({
      ...(market === null ? {} : { market: market as CyberMarketKind }),
      ...(url.searchParams.get('q') === null ? {} : { query: url.searchParams.get('q')! }),
      installed,
    })
    const items = await Promise.all(catalogItems.map(async (item) => ({
      ...item,
      ...await marketActivation(packageCatalog, item),
    })))
    writeJson(response, 200, { items })
  })

  router.get(/^\/api\/marketplace\/packages\/([^/]+)\/([^/]+)\/preview$/, async ({ response, params }) => {
    const item = await packageCatalog.find(params[0]!, params[1]!)
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    let previewPath: string | undefined
    if (item.market === 'theme') {
      const entrypoint = item.manifest.entrypoints?.find((candidate) => candidate.kind === 'world-theme')
      if (entrypoint === undefined) throw new HttpError(422, 'theme_entrypoint_missing', 'World theme entrypoint is missing')
      const rawManifest = JSON.parse((await packageCatalog.readDeclaredFile(item, entrypoint.path)).toString('utf8')) as unknown
      const validation = validateWorldThemeManifest(rawManifest)
      if (!validation.valid) throw new HttpError(422, 'invalid_world_theme', 'World theme manifest is invalid')
      const manifest = rawManifest as WorldThemeManifestV1
      previewPath = manifest.assets.find((asset) => asset.kind === 'image')?.src
    } else if (item.market === 'talent') {
      previewPath = item.manifest.files.find((file) => /\.(png|webp|jpe?g)$/i.test(file.path))?.path
    }
    if (previewPath === undefined) throw new HttpError(404, 'market_preview_missing', 'Marketplace preview is missing')
    const body = await packageCatalog.readDeclaredFile(item, previewPath)
    const contentType = previewPath.endsWith('.webp') ? 'image/webp' : previewPath.endsWith('.jpg') || previewPath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    writeBinary(response, 200, body, contentType)
  })
}

async function marketActivation(
  packageCatalog: LocalPackageCatalog,
  item: CyberMarketPackage,
): Promise<{ activation?: CyberMarketActivation }> {
  try {
    if (item.market === 'plugin') {
      const entrypoint = item.manifest.entrypoints?.find((candidate) => candidate.kind === 'prompt-transform')
      if (entrypoint === undefined) return {}
      const definition = parsePromptTransformDefinition(JSON.parse((await packageCatalog.readDeclaredFile(item, entrypoint.path)).toString('utf8')))
      const commands = definition.transforms
        .filter((transform) => transform.trigger !== 'always')
        .map((transform) => ({ trigger: transform.trigger, description: transform.description }))
      return { activation: { kind: 'prompt-transform', automatic: definition.transforms.some((transform) => transform.trigger === 'always'), commands } }
    }
    if (item.market === 'talent' && item.manifest.kind === 'employee-blueprint') {
      const entrypoint = item.manifest.entrypoints?.find((candidate) => candidate.kind === 'employee-blueprint')
      if (entrypoint === undefined) return {}
      const blueprint = parseEmployeeBlueprintManifest(
        JSON.parse((await packageCatalog.readDeclaredFile(item, entrypoint.path)).toString('utf8')),
        { packageId: item.manifest.id, packageCapabilities: item.manifest.capabilities },
      )
      return {
        activation: {
          kind: 'employee-blueprint',
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          worldTemplateId: blueprint.worldTemplateId,
        },
      }
    }
  } catch {
    // Marketplace discovery remains available for malformed third-party packages;
    // the strict preview/install path will still reject their entrypoint content.
  }
  return {}
}
