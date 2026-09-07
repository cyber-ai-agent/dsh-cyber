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

const VALID_GROUP_BY = ['all', 'provider'] as const
type ValidGroupBy = typeof VALID_GROUP_BY[number]

function isValidGroupBy(value: unknown): value is ValidGroupBy {
  return typeof value === 'string' && (VALID_GROUP_BY as readonly string[]).includes(value)
}

function toDateISOString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString()
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

  router.get(/^\/api\/workspaces\/([^/]+)\/model-stats$/, ({ response, params, url }) => {
    const workspaceId = params[0]!
    const groupByValue = url.searchParams.get('groupBy')
    const groupBy = groupByValue !== null && groupByValue !== ''
      ? (VALID_GROUP_BY.includes(groupByValue as ValidGroupBy) ? groupByValue as ValidGroupBy : 'all' as ValidGroupBy)
      : 'all' as ValidGroupBy
    const from = toDateISOString(url.searchParams.get('from'))
    const to = toDateISOString(url.searchParams.get('to'))
    if (from === undefined && url.searchParams.has('from')) {
      throw new HttpError(422, 'invalid_from_date', 'from 参数不是合法的 ISO-8601 日期')
    }
    if (to === undefined && url.searchParams.has('to')) {
      throw new HttpError(422, 'invalid_to_date', 'to 参数不是合法的 ISO-8601 日期')
    }
    writeJson(response, 200, interactions.aggregateStats(workspaceId, {
      groupBy,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(url.searchParams.has('providerId') ? { providerId: url.searchParams.get('providerId')! } : {}),
    }))
  })
}
