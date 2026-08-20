import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson, requiredString } from '../http/request.js'
import { writeBinary, writeJson } from '../http/response.js'
import type { AssetService } from '../services/asset-service.js'

export interface AssetRoutesDependencies {
  store: SqliteStore
  assets: AssetService
}

export function registerAssetRoutes(router: Router, dependencies: AssetRoutesDependencies): void {
  const { store, assets } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/assets$/, ({ response, params }) => {
    writeJson(response, 200, { items: store.listLocalAssets(params[0]!) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/assets\/background$/, async ({ request, response, params }) => {
    if (store.getWorkspace(params[0]!) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const uploaded = await assets.uploadBackground({
      workspaceId: params[0]!,
      mimeType: requiredString(body, 'mimeType'),
      dataBase64: requiredString(body, 'dataBase64'),
    })
    writeJson(response, 201, uploaded)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/assets\/attachment$/, async ({ request, response, params }) => {
    if (store.getWorkspace(params[0]!) === undefined) {
      throw new HttpError(404, 'workspace_not_found', 'Workspace not found')
    }
    const body = await readJson(request)
    const uploaded = await assets.uploadAttachment({
      workspaceId: params[0]!,
      name: requiredString(body, 'name'),
      mimeType: requiredString(body, 'mimeType'),
      dataBase64: requiredString(body, 'dataBase64'),
    })
    writeJson(response, 201, uploaded)
  })

  router.get(/^\/api\/assets\/([^/]+)$/, async ({ response, params }) => {
    const asset = await assets.read(params[0]!)
    writeBinary(response, 200, asset.body, asset.contentType)
  })
}
