import type { ModelAssignment, WorldSettings } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, record, requiredNumber, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import { WorldSettingsConflictError, type WorldSettingsService } from '../services/world-settings-service.js'

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
    const snapshot = await settings.getSnapshot(worldId)
    const modelAssignment = store.getModelAssignment(world.workspaceId, 'world', world.id)
    writeJson(response, 200, {
      settings: settingsWithModelAssignment(snapshot.settings, modelAssignment),
      revision: snapshot.revision,
      modelAssignment,
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
    const expectedRevision = requiredNumber(body, 'expectedRevision')
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new HttpError(422, 'invalid_revision', 'expectedRevision must be a non-negative integer')
    }
    const modelInputValue = body.model
    const modelInput = modelInputValue === undefined ? undefined : record(modelInputValue)
    if (modelInputValue !== undefined && modelInput === undefined) {
      throw new HttpError(422, 'invalid_model_patch', 'model must be an object')
    }
    const hasModelAssignmentPatch = modelInput !== undefined
      && Object.prototype.hasOwnProperty.call(modelInput, 'defaultModelProfileId')
    const requestedProfileId = !hasModelAssignmentPatch || modelInput!.defaultModelProfileId === null
      ? undefined
      : requiredString(modelInput!, 'defaultModelProfileId')
    if (hasModelAssignmentPatch && requestedProfileId !== undefined) {
      const profile = store.getModelProfile(requestedProfileId)
      if (profile === undefined || profile.workspaceId !== world.workspaceId) {
        throw new HttpError(422, 'world_model_profile_invalid', '所选模型不属于当前本地实例')
      }
    }
    const settingsPatch: Record<string, unknown> = { ...body }
    delete settingsPatch.expectedRevision
    delete settingsPatch.model
    if (modelInput !== undefined) {
      const { defaultModelProfileId: _defaultModelProfileId, ...fileModelPatch } = modelInput
      if (Object.keys(fileModelPatch).length > 0) settingsPatch.model = fileModelPatch
    }
    let saved: { settings: WorldSettings; revision: number }
    try {
      saved = await settings.savePatch(worldId, settingsPatch, expectedRevision)
    } catch (error) {
      if (error instanceof WorldSettingsConflictError) {
        throw new HttpError(409, 'world_settings_revision_conflict', error.message)
      }
      throw error
    }
    if (hasModelAssignmentPatch && requestedProfileId === undefined) {
      store.clearModelAssignment(world.workspaceId, 'world', world.id)
    } else if (hasModelAssignmentPatch) {
      store.saveModelAssignment({
        workspaceId: world.workspaceId,
        scope: 'world',
        scopeId: world.id,
        modelProfileId: requestedProfileId!,
      })
    }
    const modelAssignment = store.getModelAssignment(world.workspaceId, 'world', world.id)
    writeJson(response, 200, {
      settings: settingsWithModelAssignment(saved.settings, modelAssignment),
      revision: saved.revision,
      modelAssignment,
    })
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

function settingsWithModelAssignment(settings: WorldSettings, assignment: ModelAssignment | undefined): WorldSettings {
  return {
    ...settings,
    model: {
      ...settings.model,
      ...(assignment === undefined ? {} : { defaultModelProfileId: assignment.modelProfileId }),
    },
  }
}
