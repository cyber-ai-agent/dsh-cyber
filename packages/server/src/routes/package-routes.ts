import type { WorkshopCreateInput } from '@dsh-cyber/contracts/creative-platform'
import type { LocalPackageCatalog, PackageManager } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { optionalString, packageManifest, readJson, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { loadInstalledBlueprints, loadInstalledPromptTransformCommands } from '../installed-package-runtime.js'
import { AvatarBasePackService, OFFICIAL_AVATAR_BASE_PACK_ID } from '../services/avatar-base-pack-service.js'
import { validateAvatarBasePackSource } from '../services/avatar-base-pack-source-validator.js'
import type { CharacterSkillRuntime } from '../services/character-skill-runtime.js'
import type { SkillCatalogService } from '../services/skill-catalog-service.js'
import { CreativeWorkshopService } from '../services/creative-workshop-service.js'
import { CreativeWorkshopDraftService } from '../services/creative-workshop-draft-service.js'
import { CreativeWorkshopDraftGenerator, type CreativeWorkshopDraftGeneratorPort } from '../services/creative-workshop-draft-generator.js'
import type { ModelCredentialService } from '../services/model-credential-service.js'
import type { WorldMarketplaceService } from '../services/world-marketplace-service.js'
import type { WorldPackageInstanceService } from '../services/world-package-instance-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

const CREATIVE_WORKSHOP_MODEL_TIMEOUT_MS = 240_000

export interface PackageRoutesDependencies {
  store: SqliteStore
  packageManager: PackageManager
  packageCatalog: LocalPackageCatalog
  skillRuntime: CharacterSkillRuntime
  worldMarketplace: WorldMarketplaceService
  worldPackages: WorldPackageInstanceService
  worldAccess: WorldAccessService
  skillCatalog: SkillCatalogService
  credentials: ModelCredentialService
  workshopDraftGenerator?: CreativeWorkshopDraftGeneratorPort
}

export function registerPackageRoutes(router: Router, dependencies: PackageRoutesDependencies): void {
  const { store, packageManager, packageCatalog, skillRuntime, worldMarketplace, worldPackages, worldAccess, skillCatalog, credentials } = dependencies
  const workshop = new CreativeWorkshopService(store, packageManager)
  const workshopDrafts = new CreativeWorkshopDraftService(store)
  const workshopDraftGenerator = dependencies.workshopDraftGenerator
    ?? new CreativeWorkshopDraftGenerator(store, credentials, workshopDrafts, {
      skillCatalog,
      // A complete structured world + role draft is a much heavier request than
      // host-side routing/classification. Keep ModelJsonCall's fast 20s default
      // for planners while giving Creative Workshop a dedicated four-minute budget.
      timeoutMs: CREATIVE_WORKSHOP_MODEL_TIMEOUT_MS,
    })
  const avatarBasePacks = new AvatarBasePackService(worldPackages, {
    catalog: packageCatalog,
    builtInPackageIds: [OFFICIAL_AVATAR_BASE_PACK_ID],
  })

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
    if (installed.kind === 'skin' && installed.packageId === 'default-skin') {
      throw new HttpError(409, 'default_skin_required', '默认皮肤始终保留，不能卸载')
    }
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

  // Avatar Base Pack endpoints intentionally live with the package route
  // boundary. Route modules in this repository are leaves and must not import
  // one another; the service owns parsing/verification while this file only
  // translates the already-verified world-scoped result to HTTP.
  router.get(/^\/api\/worlds\/([^/]+)\/avatar-base-packs$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: await avatarBasePacks.list(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/avatar-base-packs\/([^/]+)\/([^/]+)\/assets\/(.+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    const asset = await avatarBasePacks.readBaseAsset(worldId, params[1]!, params[2]!, params[3]!)
    response.writeHead(200, {
      'content-type': asset.contentType,
      'content-length': asset.body.byteLength,
      // Installed versions are immutable and URL-versioned, so the expensive
      // shared Base VRM can be reused by many employees without refetching it.
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    response.end(asset.body)
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

  router.get(/^\/api\/workspaces\/([^/]+)\/skill-catalog$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    writeJson(response, 200, { items: await skillCatalog.listWorkspace(workspaceId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/skill-catalog$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: await skillCatalog.listWorld(worldId) })
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
    const manifest = packageManifest(body.manifest)
    const sourceDirectory = requiredString(body, 'sourceDirectory')
    assertWorkspaceInstallSource(packageCatalog, workspaceId, sourceDirectory)
    await assertAvatarBasePackInstallSource(manifest, sourceDirectory)
    const installed = await packageManager.install({
      workspaceId,
      manifest,
      sourceDirectory,
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
    const workspaceId = params[0]!
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version), { workspaceId })
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    writeJson(response, 200, {
      item,
      preview: packageManager.preview(workspaceId, item.manifest),
    })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/marketplace\/install$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const workspaceId = params[0]!
    const worldId = optionalString(body.worldId)
    if (worldId !== undefined) await assertTargetWorld(store, worldAccess, request, workspaceId, worldId)
    const item = await packageCatalog.find(requiredString(body, 'packageId'), optionalString(body.version), { workspaceId })
    if (item === undefined) throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
    assertWorkspaceInstallSource(packageCatalog, workspaceId, item.sourceDirectory)
    await assertAvatarBasePackInstallSource(item.manifest, item.sourceDirectory)
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

  router.get(/^\/api\/workspaces\/([^/]+)\/workshop\/projects$/, async ({ response, params, url }) => {
    const requested = url.searchParams.get('status')
    if (requested !== null && requested !== 'active' && requested !== 'archived' && requested !== 'all') {
      throw new HttpError(422, 'workshop_status_invalid', '项目状态筛选只支持 active、archived 或 all')
    }
    writeJson(response, 200, { items: await workshop.list(params[0]!, requested ?? 'all') })
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/workshop\/draft$/, async ({ response, params }) => {
    writeJson(response, 200, { draft: await workshopDrafts.get(params[0]!) })
  })

  router.put(/^\/api\/workspaces\/([^/]+)\/workshop\/draft$/, async ({ request, response, params }) => {
    writeJson(response, 200, { draft: await workshopDrafts.save(params[0]!, await readJson(request)) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/workshop\/draft\/generate$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const generated = await workshopDraftGenerator.generate(params[0]!, body.prompt)
    writeJson(response, 200, { draft: generated })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/workshop\/draft$/, async ({ response, params }) => {
    writeJson(response, 200, { removed: await workshopDrafts.delete(params[0]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/workshop\/projects$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const project = await workshop.create(params[0]!, body as unknown as WorkshopCreateInput)
    writeJson(response, 201, { project })
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/workshop\/projects\/([^/]+)$/, async ({ response, params }) => {
    writeJson(response, 200, { project: await workshop.readProject(params[0]!, params[1]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/workshop\/projects\/([^/]+)\/archive$/, async ({ response, params }) => {
    writeJson(response, 200, { project: await workshop.archive(params[0]!, params[1]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/workshop\/projects\/([^/]+)\/restore$/, async ({ response, params }) => {
    writeJson(response, 200, { project: await workshop.restore(params[0]!, params[1]!) })
  })

  // Deleting a project never deletes its world. The response reports the world
  // that was kept so the caller can say so instead of guessing.
  router.delete(/^\/api\/workspaces\/([^/]+)\/workshop\/projects\/([^/]+)$/, async ({ response, params }) => {
    writeJson(response, 200, { removed: true, deletion: await workshop.delete(params[0]!, params[1]!) })
  })
}

/**
 * Refuses a source directory owned by a different workspace.
 *
 * `/packages/install` takes the directory straight from the request body, so
 * scoping the catalog lookup is not enough on its own: without this check a
 * workspace could name another workspace's generated talent directory and
 * install a character it is not allowed to see.
 */
function assertWorkspaceInstallSource(
  catalog: LocalPackageCatalog,
  workspaceId: string,
  sourceDirectory: string,
): void {
  try {
    catalog.assertInstallSource(workspaceId, sourceDirectory)
  } catch {
    throw new HttpError(404, 'market_package_not_found', 'Marketplace package not found')
  }
}

async function assertAvatarBasePackInstallSource(
  manifest: Parameters<typeof validateAvatarBasePackSource>[0],
  sourceDirectory: string,
): Promise<void> {
  try {
    await validateAvatarBasePackSource(manifest, sourceDirectory)
  } catch (cause) {
    throw new HttpError(
      400,
      'avatar_base_pack_invalid',
      cause instanceof Error ? cause.message : '3D 角色基础包校验失败',
    )
  }
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
