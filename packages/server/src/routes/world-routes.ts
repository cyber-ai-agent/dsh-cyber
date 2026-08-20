import { worldTemplate } from '@dsh-cyber/catalog'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import {
  nonNegativeInteger,
  optionalPositiveInteger,
  optionalString,
  readJson,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface WorldRoutesDependencies {
  store: SqliteStore
}

export function registerWorldRoutes(router: Router, dependencies: WorldRoutesDependencies): void {
  const { store } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/worlds$/, ({ response, params }) => {
    writeJson(response, 200, { items: store.listWorlds(params[0]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/worlds$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const templateId = requiredString(body, 'templateId')
    if (worldTemplate(templateId) === undefined) {
      throw new HttpError(422, 'unknown_world_template', 'Unknown world template')
    }
    const world = store.createWorld({
      workspaceId: params[0]!,
      name: requiredString(body, 'name'),
      templateId,
    })
    writeJson(response, 201, { world })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/snapshot$/, ({ response, params }) => {
    writeJson(response, 200, store.getWorldSnapshot(params[0]!))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/events$/, ({ response, params, url }) => {
    writeJson(response, 200, {
      items: store.listWorldDomainEvents(params[0]!, nonNegativeInteger(url.searchParams.get('after'))),
    })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/sessions$/, ({ response, params }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) {
      throw new HttpError(404, 'world_not_found', 'World not found')
    }
    writeJson(response, 200, { items: store.listSessions(worldId) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/recruit$/, async ({ request, response, params }) => {
    const world = store.getWorld(params[0]!)
    if (world === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    const body = await readJson(request)
    const recruitInput: Parameters<SqliteStore['recruitEmployee']>[0] = {
      workspaceId: world.workspaceId,
      worldId: world.id,
      blueprintId: requiredString(body, 'blueprintId'),
      blueprintVersion: optionalPositiveInteger(body.blueprintVersion) ?? 1,
    }
    const displayName = optionalString(body.displayName)
    if (displayName !== undefined) recruitInput.displayName = displayName
    writeJson(response, 201, { employee: store.recruitEmployee(recruitInput) })
  })
}
