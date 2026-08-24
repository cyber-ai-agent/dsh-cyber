import type { JsonObject } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { readJson, record, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import type { IntegrationService } from '../integrations/integration-service.js'

export function registerIntegrationRoutes(router: Router, dependencies: { store: SqliteStore; integrations: IntegrationService; onChanged?: (integrationId: string) => Promise<void> }): void {
  const { store, integrations, onChanged } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/integrations$/, ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!)
    writeJson(response, 200, { descriptors: integrations.descriptors(), items: integrations.list(workspaceId) })
  })

  router.put(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)$/, async ({ request, response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!); const integrationId = params[1]!
    const body = await readJson(request); const config = record(body.config) ?? {}
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(422, 'integration_enabled_invalid', 'enabled must be boolean')
    if (body.clearCredential !== undefined && typeof body.clearCredential !== 'boolean') throw new HttpError(422, 'integration_clear_credential_invalid', 'clearCredential must be boolean')
    let connection
    try {
      connection = await integrations.save({
        workspaceId, integrationId, config: config as JsonObject, enabled: body.enabled !== false,
        ...(body.displayName === undefined ? {} : { displayName: requiredString(body, 'displayName') }),
        ...(body.credential === undefined ? {} : { credential: requiredString(body, 'credential') }),
        ...(body.clearCredential === true ? { clearCredential: true } : {}),
      })
    } catch (error) {
      throw new HttpError(422, 'integration_config_invalid', error instanceof Error ? error.message : 'Integration configuration is invalid')
    }
    await onChanged?.(integrationId)
    writeJson(response, 200, { connection })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)\/test$/, async ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!)
    const integrationId = params[1]!
    const health = await integrations.test(workspaceId, integrationId)
    if (health.status === 'ready') await onChanged?.(integrationId)
    writeJson(response, 200, { health })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/integrations\/([^/]+)$/, async ({ response, params }) => {
    const workspaceId = requireWorkspace(store, params[0]!)
    const integrationId = params[1]!
    const removed = await integrations.delete(workspaceId, integrationId)
    if (removed) await onChanged?.(integrationId)
    writeJson(response, 200, { removed })
  })
}

function requireWorkspace(store: SqliteStore, workspaceId: string): string {
  if (store.getWorkspace(workspaceId) === undefined) throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
  return workspaceId
}
