import type { SqliteStore } from '@dsh-cyber/persistence'

import type { Router } from '../http/router.js'
import {
  nullableString,
  readJson,
  requiredEnum,
  requiredNumber,
  requiredString,
} from '../http/request.js'
import { writeJson } from '../http/response.js'

export interface WorkspaceRoutesDependencies {
  store: SqliteStore
}

export function registerWorkspaceRoutes(
  router: Router,
  dependencies: WorkspaceRoutesDependencies,
): void {
  const { store } = dependencies

  router.get('/api/workspaces', ({ response }) => {
    writeJson(response, 200, { items: store.listWorkspaces() })
  })

  router.post('/api/workspaces', async ({ request, response }) => {
    const body = await readJson(request)
    const workspace = store.createWorkspace({ name: requiredString(body, 'name') })
    writeJson(response, 201, { workspace })
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/snapshot$/, ({ response, params }) => {
    writeJson(response, 200, store.getWorkspaceSnapshot(params[0]!))
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/preferences$/, ({ response, params }) => {
    writeJson(response, 200, { preferences: store.getWorkspacePreferences(params[0]!) })
  })

  router.put(/^\/api\/workspaces\/([^/]+)\/preferences$/, async ({ request, response, params }) => {
    const body = await readJson(request)
    const preferences = store.updateWorkspacePreferences({
      workspaceId: params[0]!,
      ...(body.colorScheme === undefined
        ? {}
        : { colorScheme: requiredEnum(body, 'colorScheme', ['system', 'light', 'dark']) }),
      ...(body.skinId === undefined ? {} : { skinId: requiredString(body, 'skinId') }),
      ...(body.backgroundAssetRef === undefined
        ? {}
        : { backgroundAssetRef: nullableString(body.backgroundAssetRef) }),
      ...(body.backgroundFit === undefined
        ? {}
        : { backgroundFit: requiredEnum(body, 'backgroundFit', ['cover', 'contain', 'tile']) }),
      ...(body.backgroundOpacity === undefined
        ? {}
        : { backgroundOpacity: requiredNumber(body, 'backgroundOpacity') }),
      ...(body.interfaceDensity === undefined
        ? {}
        : { interfaceDensity: requiredEnum(body, 'interfaceDensity', ['comfortable', 'compact']) }),
      ...(body.motion === undefined
        ? {}
        : { motion: requiredEnum(body, 'motion', ['system', 'reduced', 'full']) }),
      ...(body.leftPaneWidth === undefined
        ? {}
        : { leftPaneWidth: requiredNumber(body, 'leftPaneWidth') }),
      ...(body.rightPaneWidth === undefined
        ? {}
        : { rightPaneWidth: requiredNumber(body, 'rightPaneWidth') }),
    })
    writeJson(response, 200, { preferences })
  })
}
