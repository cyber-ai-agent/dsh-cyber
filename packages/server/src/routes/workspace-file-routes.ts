import type { Router } from '../http/router.js'
import { writeJson, writeWorkspaceFile } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldFileService } from '../services/world-file-service.js'

export function registerWorkspaceFileRoutes(router: Router, dependencies: { worldFiles: WorldFileService; access: WorldAccessService }): void {
  const { worldFiles, access } = dependencies
  router.get(/^\/api\/worlds\/([^/]+)\/files$/, async ({ request, response, params, url }) => { await access.assertUnlocked(params[0]!, request); writeJson(response, 200, await worldFiles.list(params[0]!, url.searchParams.get('path') ?? '')) })
  router.get(/^\/api\/worlds\/([^/]+)\/file$/, async ({ request, response, params, url }) => { await access.assertUnlocked(params[0]!, request); const preview = await worldFiles.preview(params[0]!, url.searchParams.get('path') ?? ''); writeWorkspaceFile(response, preview.body, preview.contentType) })
}
