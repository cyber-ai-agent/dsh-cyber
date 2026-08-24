import type { WorkshopCreateInput } from '@dsh-cyber/contracts/creative-platform'
import type { LocalPackageCatalog, PackageManager } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { optionalString, packageManifest, readJson, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { loadInstalledBlueprints, loadInstalledPromptTransformCommands } from '../installed-package-runtime.js'
import type { CharacterSkillRuntime } from '../services/character-skill-runtime.js'
import { CreativeWorkshopService } from '../services/creative-workshop-service.js'
import type { WorldMarketplaceService } from '../services/world-marketplace-service.js'

export interface PackageRoutesDependencies {
  store: SqliteStore
  packageManager: PackageManager
  packageCatalog: LocalPackageCatalog
  skillRuntime: CharacterSkillRuntime
  worldMarketplace: WorldMarketplaceService
}

export function registerPackageRoutes(router: Router, dependencies: PackageRoutesDependencies): void {
  const { store, packageManager, packageCatalog, skillRuntime, worldMarketplace } = dependencies
  const workshop = new CreativeWorkshopService(store, packageManager)

  router.get(/^\/api\/workspaces\/([^/]+)\/packages$/, ({ response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    writeJson(response, 200, {
      items: store.listInstalledPackages(workspaceId),
      transactions: store.listPackageInstallTransactions(workspaceId),
    })
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/plugins$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    const items = await loadInstalledPromptTransformCommands(store.listInstalledPackages(workspaceId))
    writeJson(response, 200, { items })
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/skill-catalog$/, ({ response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    writeJson(response, 200, { items: skillRuntime.listDescriptors() })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/packages\/preview$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    const body = await readJson(request)
    writeJson(response, 200, packageManager.preview(workspaceId, packageManifest(body.manifest)))
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/packages\/install$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    const body = await readJson(request)
    const installed = await packageManager.install({
      workspaceId,
      manifest: packageManifest(body.manifest),
      sourceDirectory: requiredString(body, 'sourceDirectory'),
      approvalToken: requiredString(body, 'approvalToken'),
      actorId: 'owner',
    })
    if (installed.kind === 'employee-blueprint') {
      for (const blueprint of await loadInstalledBlueprints([installed])) store.saveBlueprint(blueprint)
    }
    writeJson(response, 201, { installed })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/marketplace\/preview$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version))
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    writeJson(response, 200, {
      item,
      preview: packageManager.preview(params[0]!, item.manifest),
    })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/marketplace\/install$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version))
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    const installed = await packageManager.install({
      workspaceId: params[0]!,
      manifest: item.manifest,
      sourceDirectory: item.sourceDirectory,
      approvalToken: requiredString(body, 'approvalToken'),
      actorId: 'owner',
    })
    if (installed.kind === 'employee-blueprint') {
      for (const blueprint of await loadInstalledBlueprints([installed])) store.saveBlueprint(blueprint)
    }
    writeJson(response, 201, { installed })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/marketplace\/worlds$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const result = await worldMarketplace.createFromInstalledTheme({
      workspaceId: params[0]!,
      packageId: requiredString(body, 'packageId'),
      name: requiredString(body, 'name'),
    })
    writeJson(response, 201, result)
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/workshop\/projects$/, async ({ response, params }) => {
    writeJson(response, 200, { items: await workshop.list(params[0]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/workshop\/projects$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const project = await workshop.create(params[0]!, body as unknown as WorkshopCreateInput)
    writeJson(response, 201, { project })
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/workshop\/projects\/([^/]+)$/, async ({ response, params }) => {
    writeJson(response, 200, { project: await workshop.readProject(params[0]!, params[1]!) })
  })
}
