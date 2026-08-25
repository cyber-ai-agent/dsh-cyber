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
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

export interface PackageRoutesDependencies {
  store: SqliteStore
  packageManager: PackageManager
  packageCatalog: LocalPackageCatalog
  skillRuntime: CharacterSkillRuntime
  worldMarketplace: WorldMarketplaceService
  worldPackages: WorldPackageInstanceService
  worldAccess: WorldAccessService
}

export function registerPackageRoutes(router: Router, dependencies: PackageRoutesDependencies): void {
  const { store, packageManager, packageCatalog, skillRuntime, worldMarketplace, worldPackages, worldAccess } = dependencies
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

  router.delete(/^\/api\/workspaces\/([^/]+)\/packages\/([^/]+)$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    const packageId = params[1]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    const installed = store.getActivePackage(workspaceId, packageId)
    if (installed === undefined) throw new HttpError(404, 'package_not_installed', 'Package is not installed')
    const worlds = store.listWorlds(workspaceId, true).filter((world) => world.status === 'active')
    for (const world of worlds) await worldAccess.assertUnlocked(world.id, request)
    let disabledWorldInstances = 0
    for (const world of worlds) {
      for (const instance of store.listWorldPackageInstances(world.id, 'active').filter((item) => item.packageId === packageId)) {
        store.disableWorldPackageInstance(instance.id)
        disabledWorldInstances += 1
      }
    }
    const removed = store.disableInstalledPackage(workspaceId, packageId, installed.version)
    writeJson(response, 200, { removed, disabledWorldInstances })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/packages$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: store.listWorldPackageInstances(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/plugins$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    const items = await loadInstalledPromptTransformCommands(await worldPackages.listRuntimePackages(worldId))
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/packages\/instantiate$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    await worldAccess.assertUnlocked(params[0]!, request)
    const instance = await worldPackages.instantiate({
      worldId: params[0]!, packageId: requiredString(body, 'packageId'),
      version: requiredString(body, 'version'), actorId: 'owner',
    })
    writeJson(response, 201, { instance })
  })

  router.post(/^\/api\/world-package-instances\/([^/]+)\/disable$/, async ({ request, response, params }) => {
    const instance = store.getWorldPackageInstance(params[0]!)
    if (instance === undefined) throw new HttpError(404, 'world_package_instance_not_found', 'World package instance not found')
    await worldAccess.assertUnlocked(instance.worldId, request)
    writeJson(response, 200, { instance: store.disableWorldPackageInstance(instance.id) })
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
    const worldId = optionalString(body.worldId)
    if (worldId !== undefined) await assertTargetWorld(store, worldAccess, request, workspaceId, worldId)
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
    const instance = worldId === undefined ? undefined : await worldPackages.instantiate({
      worldId, packageId: installed.packageId, version: installed.version, actorId: 'owner',
    })
    writeJson(response, 201, { installed, ...(instance === undefined ? {} : { instance }) })
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
    const workspaceId = params[0]!
    const worldId = optionalString(body.worldId)
    if (worldId !== undefined) await assertTargetWorld(store, worldAccess, request, workspaceId, worldId)
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version))
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    const installed = await packageManager.install({
      workspaceId,
      manifest: item.manifest,
      sourceDirectory: item.sourceDirectory,
      approvalToken: requiredString(body, 'approvalToken'),
      actorId: 'owner',
    })
    if (installed.kind === 'employee-blueprint') {
      for (const blueprint of await loadInstalledBlueprints([installed])) store.saveBlueprint(blueprint)
    }
    const instance = worldId === undefined ? undefined : await worldPackages.instantiate({
      worldId, packageId: installed.packageId, version: installed.version, actorId: 'owner',
    })
    writeJson(response, 201, { installed, ...(instance === undefined ? {} : { instance }) })
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

async function assertTargetWorld(
  store: SqliteStore,
  access: WorldAccessService,
  request: Parameters<WorldAccessService['assertUnlocked']>[1],
  workspaceId: string,
  worldId: string,
): Promise<void> {
  const world = store.getWorld(worldId)
  if (world === undefined || world.workspaceId !== workspaceId) {
    throw new HttpError(404, 'world_not_found', 'World not found in this workspace')
  }
  await access.assertUnlocked(worldId, request)
}
