import type { Router } from '../http/router.js'
import { writeJson, writeWorkspaceFile } from '../http/response.js'
import type { WorkspaceFileService } from '../services/workspace-file-service.js'

export interface WorkspaceFileRoutesDependencies {
  workspaceFiles: WorkspaceFileService
}

export function registerWorkspaceFileRoutes(
  router: Router,
  dependencies: WorkspaceFileRoutesDependencies,
): void {
  const { workspaceFiles } = dependencies

  router.get('/api/workspace/files', async ({ response, url }) => {
    writeJson(response, 200, await workspaceFiles.list(url.searchParams.get('path') ?? ''))
  })

  router.get('/api/workspace/file', async ({ response, url }) => {
    const preview = await workspaceFiles.preview(url.searchParams.get('path') ?? '')
    writeWorkspaceFile(response, preview.body, preview.contentType)
  })
}
