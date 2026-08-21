import type { WorldSettings } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldSettingsService } from '../services/world-settings-service.js'

export function registerWorldSettingsRoutes(
  router: Router,
  dependencies: { store: SqliteStore; settings: WorldSettingsService; access: WorldAccessService },
): void {
  const { store, settings, access } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/settings$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    const world = store.getWorld(worldId)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, {
      settings: await settings.get(worldId),
      access: await access.summary(worldId, request),
      models: store.listModelProfiles(world.workspaceId),
    })
  })

  router.put(/^\/api\/worlds\/([^/]+)\/settings$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    const world = store.getWorld(worldId)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const modelInput = record(body.model)
    const requestedProfileId = modelInput?.defaultModelProfileId === undefined
      ? undefined
      : requiredString(modelInput, 'defaultModelProfileId')
    if (requestedProfileId !== undefined) {
      const profile = store.getModelProfile(requestedProfileId)
      if (profile === undefined || profile.workspaceId !== world.workspaceId) {
        throw new HttpError(422, 'world_model_profile_invalid', '所选模型不属于当前本地实例')
      }
    }
    const saved = await settings.save(worldId, body as Partial<WorldSettings>)
    if (saved.model.defaultModelProfileId === undefined) {
      store.clearModelAssignment(world.workspaceId, 'world', world.id)
    } else {
      store.saveModelAssignment({
        workspaceId: world.workspaceId,
        scope: 'world',
        scopeId: world.id,
        modelProfileId: saved.model.defaultModelProfileId,
      })
    }
    writeJson(response, 200, { settings: saved })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/access$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    writeJson(response, 200, { access: await access.summary(worldId, request) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/access\/password$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    const current = await access.summary(worldId, request)
    if (current.passwordEnabled) await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    writeJson(response, 200, {
      access: await access.setPassword(worldId, requiredString(body, 'password'), response),
    })
  })

  router.delete(/^\/api\/worlds\/([^/]+)\/access\/password$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, { access: await access.clearPassword(worldId, response) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/access\/unlock$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    const body = await readJson(request)
    writeJson(response, 200, {
      access: await access.unlock(worldId, requiredString(body, 'password'), request, response),
    })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/access\/lock$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    access.lock(worldId, request, response)
    writeJson(response, 200, { ok: true })
  })
}
