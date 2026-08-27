import {
  parseWorkspacePaneWidth,
  WorkspacePreferencesContractError,
  type WorkspacePaneWidthKey,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
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
      ...(body.locale === undefined
        ? {}
        : { locale: requiredEnum(body, 'locale', ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'ru-RU', 'ar-SA', 'hi-IN']) }),
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
        : { leftPaneWidth: workspacePaneWidth(body, 'leftPaneWidth') }),
      ...(body.rightPaneWidth === undefined
        ? {}
        : { rightPaneWidth: workspacePaneWidth(body, 'rightPaneWidth') }),
    })
    writeJson(response, 200, { preferences })
  })
}

function workspacePaneWidth(body: Record<string, unknown>, key: WorkspacePaneWidthKey): number {
  try {
    return parseWorkspacePaneWidth(key, requiredNumber(body, key))
  } catch (error) {
    if (error instanceof WorkspacePreferencesContractError) {
      throw new HttpError(422, error.code, error.message)
    }
    throw error
  }
}
