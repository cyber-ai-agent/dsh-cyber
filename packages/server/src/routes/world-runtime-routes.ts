import type {
  JsonObject,
  WorldInteractionAction,
  WorldInteractionRequest,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import {
  optionalString,
  optionalStringArray,
  readJson,
  record,
  requiredEnum,
  requiredString,
} from '../http/request.js'
import { writeBinary, writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldStreamHub } from '../streams/world-stream-hub.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'

export interface WorldRuntimeRoutesDependencies {
  store: SqliteStore
  worldRuntime: WorldRuntimeService
  worldStreamHub: WorldStreamHub
  worldAccess: WorldAccessService
}

export function registerWorldRuntimeRoutes(
  router: Router,
  dependencies: WorldRuntimeRoutesDependencies,
): void {
  const { store, worldRuntime, worldStreamHub, worldAccess } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/runtime-snapshot$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, worldRuntime.getSnapshot(worldId))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/runtime-capability$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    const supported = worldRuntime.supports(worldId)
    writeJson(response, 200, {
      supported,
      ...(supported ? { renderer: worldRuntime.getThemeManifest(worldId).renderer } : {}),
    })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/theme-manifest$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, worldRuntime.getThemeManifest(worldId))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/themes$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    writeJson(response, 200, await worldRuntime.listThemes(worldId))
  })

  router.put(/^\/api\/worlds\/([^/]+)\/theme-binding$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const action = requiredEnum(body, 'action', ['bind', 'disable', 'fallback'])
    const snapshot = action === 'bind'
      ? await worldRuntime.bindInstalledTheme(worldId, requiredString(body, 'packageId'))
      : worldRuntime.useBuiltInTheme(worldId)
    writeJson(response, 200, { action, snapshot, binding: store.getWorldThemeBinding(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/theme-assets\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    const asset = await worldRuntime.getThemeAsset(worldId, params[1]!)
    writeBinary(response, 200, asset.body, asset.contentType)
  })

  router.post(/^\/api\/worlds\/([^/]+)\/interactions$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await worldAccess.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const action = requiredEnum<WorldInteractionAction>(body, 'action', [
      'focus',
      'talk',
      'assign-task',
      'inspect',
      'use-object',
      'start-meeting',
      'toggle-lights',
      'fit-camera',
    ])
    const interaction: WorldInteractionRequest = {
      action,
      actorId: optionalString(body.actorId) ?? 'owner',
      ...(optionalString(body.entityId) === undefined ? {} : { entityId: optionalString(body.entityId)! }),
      ...(optionalString(body.objectId) === undefined ? {} : { objectId: optionalString(body.objectId)! }),
      ...(body.participantIds === undefined ? {} : { participantIds: optionalStringArray(body.participantIds) }),
      ...(optionalString(body.prompt) === undefined ? {} : { prompt: optionalString(body.prompt)! }),
      ...(record(body.metadata) === undefined ? {} : { metadata: record(body.metadata) as JsonObject }),
    }
    writeJson(response, 202, worldRuntime.interact(worldId, interaction))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/stream$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    await worldAccess.assertUnlocked(worldId, request)
    worldStreamHub.connect(
      worldId,
      request,
      response,
      worldRuntime.getSnapshot(worldId),
      url.searchParams.get('after'),
    )
  })
}
