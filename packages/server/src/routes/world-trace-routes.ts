import type { ContextInspectionResponse } from '@dsh-cyber/contracts'
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
import type { ContextInspectionService } from '../services/context-inspection-service.js'
import { InvalidWorldTraceCursorError, type WorldTraceService } from '../services/world-trace-service.js'

export interface WorldTraceRoutesDependencies {
  store: SqliteStore
  trace: WorldTraceService
  access: WorldAccessService
  /**
   * The Context Inspector's record, mounted alongside the trace because that
   * is where the product surfaces it: 运行轨迹 → 上下文. Optional so a narrower
   * embedder can register the trace without it.
   */
  contextInspection?: Pick<ContextInspectionService, 'latest'>
}

export function registerWorldTraceRoutes(router: Router, dependencies: WorldTraceRoutesDependencies): void {
  const { store, trace, access, contextInspection } = dependencies
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

  /**
   * The context structure the conversation's last turn was actually given.
   *
   * It is mounted with the trace because that is where the product surfaces
   * it (运行轨迹 → 上下文), and it is read-only by construction: the record is
   * process-local, so an empty answer is a normal answer rather than an error.
   */
  if (contextInspection !== undefined) {
    router.get(/^\/api\/sessions\/([^/]+)\/context-inspection$/, async ({ request, response, params }) => {
      const session = store.getSession(params[0]!)
      if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
      // Readable only by someone who may open the world it belongs to.
      await access.assertUnlocked(session.worldId, request)
      const latest = contextInspection.latest(session.id)
      const body: ContextInspectionResponse = latest === undefined ? {} : { inspection: latest }
      writeJson(response, 200, body)
    })
  }
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
  const date = search.get('date')?.trim() || undefined
  const keyword = search.get('search')?.trim() || undefined
  if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)))) {
    throw new HttpError(422, 'invalid_trace_date', '轨迹日期格式必须为 YYYY-MM-DD')
  }
  if (keyword !== undefined && keyword.length > 120) {
    throw new HttpError(422, 'invalid_trace_search', '轨迹搜索内容不能超过 120 个字符')
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
    ...(category === undefined ? {} : { category: category as WorldTraceCategory }),
    ...(status === undefined ? {} : { status: status as WorldTraceStatus }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(date === undefined ? {} : { date }),
    ...(keyword === undefined ? {} : { search: keyword }),
  }
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[], code: string): T | undefined {
  if (value === null || value.trim() === '') return undefined
  if (!allowed.includes(value as T)) throw new HttpError(422, code, '不支持的轨迹筛选条件')
  return value as T
}
