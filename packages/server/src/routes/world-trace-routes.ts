import {
  WORLD_TRACE_CATEGORIES,
  WORLD_TRACE_STATUSES,
  type WorldTraceCategory,
  type WorldTraceQuery,
  type WorldTraceStatus,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import { InvalidWorldTraceCursorError, type WorldTraceService } from '../services/world-trace-service.js'

export interface WorldTraceRoutesDependencies {
  store: SqliteStore
  trace: WorldTraceService
  access: WorldAccessService
}

export function registerWorldTraceRoutes(router: Router, dependencies: WorldTraceRoutesDependencies): void {
  const { store, trace, access } = dependencies
  router.get(/^\/api\/worlds\/([^/]+)\/trace$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
    await access.assertUnlocked(worldId, request)
    const query = traceQuery(url.searchParams)
    try {
      writeJson(response, 200, await trace.list(worldId, query))
    } catch (error) {
      if (error instanceof InvalidWorldTraceCursorError) {
        throw new HttpError(422, 'invalid_trace_cursor', '轨迹游标无效，请刷新后重试')
      }
      throw error
    }
  })
}

function traceQuery(search: URLSearchParams): WorldTraceQuery {
  const limitValue = search.get('limit')
  const limit = limitValue === null ? undefined : Number(limitValue)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw new HttpError(422, 'invalid_trace_limit', '轨迹分页数量必须在 1 到 200 之间')
  }
  const category = optionalEnum(search.get('category'), WORLD_TRACE_CATEGORIES, 'invalid_trace_category')
  const status = optionalEnum(search.get('status'), WORLD_TRACE_STATUSES, 'invalid_trace_status')
  const after = search.get('after')?.trim() || undefined
  const actorId = search.get('actorId')?.trim() || undefined
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
    ...(category === undefined ? {} : { category: category as WorldTraceCategory }),
    ...(status === undefined ? {} : { status: status as WorldTraceStatus }),
    ...(actorId === undefined ? {} : { actorId }),
  }
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[], code: string): T | undefined {
  if (value === null || value.trim() === '') return undefined
  if (!allowed.includes(value as T)) throw new HttpError(422, code, '不支持的轨迹筛选条件')
  return value as T
}
