import type { WorldSettings } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { Router } from '../http/router.js'
import { readJson, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldSettingsService } from '../services/world-settings-service.js'

export function registerWorldSettingsRoutes(router: Router, dependencies: { store: SqliteStore; settings: WorldSettingsService; access: WorldAccessService }) {
  const { store, settings, access } = dependencies
  router.get(/^\/api\/worlds\/([^/]+)\/settings$/, async ({ request, response, params }) => { const worldId = params[0]!; if (store.getWorld(worldId) === undefined) throw new Error('World not found'); await access.assertUnlocked(worldId, request); writeJson(response, 200, { settings: await settings.get(worldId), access: await access.summary(worldId, request), models: store.listModelProfiles(store.getWorld(worldId)!.workspaceId) }) })
  router.put(/^\/api\/worlds\/([^/]+)\/settings$/, async ({ request, response, params }) => { const worldId = params[0]!; await access.assertUnlocked(worldId, request); const body = await readJson(request); writeJson(response, 200, { settings: await settings.save(worldId, body as Partial<WorldSettings>) }) })
  router.get(/^\/api\/worlds\/([^/]+)\/access$/, async ({ request, response, params }) => writeJson(response, 200, { access: await access.summary(params[0]!, request) }))
  router.post(/^\/api\/worlds\/([^/]+)\/access\/password$/, async ({ request, response, params }) => { const body = await readJson(request); writeJson(response, 200, { access: await access.setPassword(params[0]!, requiredString(body, 'password'), response) }) })
  router.delete(/^\/api\/worlds\/([^/]+)\/access\/password$/, async ({ response, params }) => writeJson(response, 200, { access: await access.clearPassword(params[0]!, response) }))
  router.post(/^\/api\/worlds\/([^/]+)\/access\/unlock$/, async ({ request, response, params }) => { const body = await readJson(request); writeJson(response, 200, { access: await access.unlock(params[0]!, requiredString(body, 'password'), request, response) }) })
  router.post(/^\/api\/worlds\/([^/]+)\/access\/lock$/, async ({ request, response, params }) => { access.lock(params[0]!, request, response); writeJson(response, 200, { ok: true }) })
}
