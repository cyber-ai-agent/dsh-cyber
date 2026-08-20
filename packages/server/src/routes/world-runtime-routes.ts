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
import type { WorldStreamHub } from '../streams/world-stream-hub.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'

export interface WorldRuntimeRoutesDependencies {
  store: SqliteStore
  worldRuntime: WorldRuntimeService
  worldStreamHub: WorldStreamHub
}

export function registerWorldRuntimeRoutes(
  router: Router,
  dependencies: WorldRuntimeRoutesDependencies,
): void {
  const { store, worldRuntime, worldStreamHub } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/runtime-snapshot$/, ({ response, params }) => {
    writeJson(response, 200, worldRuntime.getSnapshot(params[0]!))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/runtime-capability$/, ({ response, params }) => {
    const worldId = params[0]!
    const supported = worldRuntime.supports(worldId)
    writeJson(response, 200, {
      supported,
      ...(supported ? { renderer: worldRuntime.getThemeManifest(worldId).renderer } : {}),
    })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/theme-manifest$/, ({ response, params }) => {
    writeJson(response, 200, worldRuntime.getThemeManifest(params[0]!))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/themes$/, async ({ response, params }) => {
    writeJson(response, 200, await worldRuntime.listThemes(params[0]!))
  })

  router.put(/^\/api\/worlds\/([^/]+)\/theme-binding$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    const body = await readJson(request)
    const action = requiredEnum(body, 'action', ['bind', 'disable', 'fallback'])
    const snapshot = action === 'bind'
      ? await worldRuntime.bindInstalledTheme(worldId, requiredString(body, 'packageId'))
      : worldRuntime.useBuiltInTheme(worldId)
    writeJson(response, 200, { action, snapshot, binding: store.getWorldThemeBinding(worldId) })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/theme-assets\/([^/]+)$/, async ({ response, params }) => {
    const asset = await worldRuntime.getThemeAsset(params[0]!, params[1]!)
    writeBinary(response, 200, asset.body, asset.contentType)
  })

  router.post(/^\/api\/worlds\/([^/]+)\/interactions$/, async ({ request, response, params }) => {
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
    writeJson(response, 202, worldRuntime.interact(params[0]!, interaction))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/stream$/, ({ request, response, params, url }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    worldStreamHub.connect(
      worldId,
      request,
      response,
      worldRuntime.getSnapshot(worldId),
      url.searchParams.get('after'),
    )
  })
}
