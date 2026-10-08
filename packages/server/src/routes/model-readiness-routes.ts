import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import { optionalString, optionalStringArray, readJson, record } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { ModelReadinessService } from '../services/model-readiness-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

export function registerModelReadinessRoutes(router: Router, dependencies: {
  readiness: ModelReadinessService
  worldAccess: WorldAccessService
}): void {
  router.post(/^\/api\/worlds\/([^/]+)\/model-readiness$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await dependencies.worldAccess.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const employeeIds = optionalStringArray(body.employeeIds)
    const modelProfileId = optionalString(body.modelProfileId)
    const rawProfiles = record(body.modelProfileIds)
    if (body.modelProfileIds !== undefined && (rawProfiles === undefined || Object.values(rawProfiles).some((value) => typeof value !== 'string' || !value.trim()))) {
      throw new HttpError(422, 'conversation_model_unavailable', '角色模型配置无效')
    }
    writeJson(response, 200, await dependencies.readiness.inspect(worldId, {
      employeeIds,
      ...(modelProfileId === undefined ? {} : { modelProfileId }),
      ...(rawProfiles === undefined ? {} : { modelProfileIds: rawProfiles as Record<string, string> }),
    }))
  })
}
