import type { Router } from '../http/router.js'
import { readJson, requiredString } from '../http/request.js'
import { writeJson, writeWorkspaceFile } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldFileService } from '../services/world-file-service.js'

export function registerWorkspaceFileRoutes(router: Router, dependencies: { worldFiles: WorldFileService; access: WorldAccessService }): void {
  const { worldFiles, access } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/files$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, await worldFiles.list(worldId, url.searchParams.get('path') ?? ''))
  })

  router.get(/^\/api\/worlds\/([^/]+)\/file$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    await access.assertUnlocked(worldId, request)
    const preview = await worldFiles.preview(worldId, url.searchParams.get('path') ?? '')
    writeWorkspaceFile(response, preview.body, preview.contentType)
  })

  router.post(/^\/api\/worlds\/([^/]+)\/assets\/attachment$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const attachment = await worldFiles.uploadAttachment(worldId, {
      name: requiredString(body, 'name'),
      mimeType: requiredString(body, 'mimeType'),
      dataBase64: requiredString(body, 'dataBase64'),
    })
    writeJson(response, 201, { attachment })
  })

  router.get(/^\/api\/worlds\/([^/]+)\/assets\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    await access.assertUnlocked(worldId, request)
    const asset = await worldFiles.readAttachment(worldId, params[1]!)
    writeWorkspaceFile(response, asset.body, asset.contentType)
  })
}
