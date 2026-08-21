import type { ModelInteractionLogStatus } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { nonNegativeInteger, optionalString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { ModelInteractionService } from '../services/model-interaction-service.js'

export interface ModelInteractionRoutesDependencies {
  store: SqliteStore
  interactions: ModelInteractionService
}

export function registerModelInteractionRoutes(
  router: Router,
  dependencies: ModelInteractionRoutesDependencies,
): void {
  const { interactions } = dependencies

  router.get(/^\/api\/workspaces\/([^/]+)\/model-interactions$/, ({ response, params, url }) => {
    const workspaceId = params[0]!
    const statusValue = url.searchParams.get('status')
    let status: ModelInteractionLogStatus | undefined
    if (statusValue !== null && statusValue !== '') {
      if (statusValue !== 'success' && statusValue !== 'failed') {
        throw new HttpError(422, 'invalid_status_filter', '状态筛选只支持 success 或 failed')
      }
      status = statusValue
    }
    const modelId = optionalString(url.searchParams.get('modelId'))
    const page = Math.max(1, nonNegativeInteger(url.searchParams.get('page')) || 1)
    const pageSize = Math.min(100, Math.max(1, nonNegativeInteger(url.searchParams.get('pageSize')) || 20))
    writeJson(response, 200, interactions.list(workspaceId, {
      ...(status === undefined ? {} : { status }),
      ...(modelId === undefined ? {} : { modelId }),
      page,
      pageSize,
    }))
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/model-interactions\/([^/]+)$/, ({ response, params }) => {
    const log = interactions.get(params[1]!)
    if (log === undefined || log.workspaceId !== params[0]) {
      throw new HttpError(404, 'model_interaction_not_found', '模型交互日志不存在')
    }
    writeJson(response, 200, { log })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/model-interactions$/, ({ response, params }) => {
    const removed = interactions.clear(params[0]!)
    writeJson(response, 200, { removed })
  })
}
