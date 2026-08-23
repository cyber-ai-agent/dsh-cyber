import type { AgentPermissionMode, TaskScheduleKind } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { optionalPositiveInteger, optionalString, readJson, requiredEnum, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import type { TaskScheduleService } from '../services/task-schedule-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

export function registerTaskScheduleRoutes(router: Router, dependencies: { store: SqliteStore; schedules: TaskScheduleService; access: WorldAccessService }): void {
  const { store, schedules, access } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/schedules$/, async ({ request, response, params }) => {
    const worldId = requireWorld(store, params[0]!)
    await access.assertUnlocked(worldId, request)
    writeJson(response, 200, { items: schedules.list(worldId) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/schedules$/, async ({ request, response, params }) => {
    const worldId = requireWorld(store, params[0]!)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    try {
      const everySeconds = optionalPositiveInteger(body.everySeconds)
      const timeZone = optionalString(body.timeZone)
      const item = schedules.create({
        worldId,
        employeeId: requiredString(body, 'employeeId'),
        title: requiredString(body, 'title'),
        prompt: requiredString(body, 'prompt'),
        kind: requiredEnum<TaskScheduleKind>(body, 'kind', ['once', 'interval']),
        scheduledAt: requiredString(body, 'scheduledAt'),
        ...(everySeconds === undefined ? {} : { everySeconds }),
        ...(timeZone === undefined ? {} : { timeZone }),
        permissionMode: requiredEnum<Exclude<AgentPermissionMode, 'danger-full-access'>>(body, 'permissionMode', ['read-only', 'workspace-write']),
      })
      writeJson(response, 201, { item })
    } catch (cause) {
      if (cause instanceof HttpError) throw cause
      throw new HttpError(422, 'invalid_schedule', cause instanceof Error ? cause.message : '计划参数无效')
    }
  })

  router.route('PATCH', /^\/api\/worlds\/([^/]+)\/schedules\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = requireWorld(store, params[0]!)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const status = requiredEnum(body, 'status', ['active', 'paused'])
    try { writeJson(response, 200, { item: schedules.setStatus(worldId, params[1]!, status) }) }
    catch (cause) { throw scheduleError(cause) }
  })

  router.delete(/^\/api\/worlds\/([^/]+)\/schedules\/([^/]+)$/, async ({ request, response, params }) => {
    const worldId = requireWorld(store, params[0]!)
    await access.assertUnlocked(worldId, request)
    try { writeJson(response, 200, { removed: schedules.delete(worldId, params[1]!) }) }
    catch (cause) { throw scheduleError(cause) }
  })

  router.post(/^\/api\/worlds\/([^/]+)\/schedules\/([^/]+)\/run$/, async ({ request, response, params }) => {
    const worldId = requireWorld(store, params[0]!)
    await access.assertUnlocked(worldId, request)
    try { writeJson(response, 200, { run: await schedules.runNow(worldId, params[1]!) }) }
    catch (cause) { throw scheduleError(cause) }
  })

  router.get(/^\/api\/worlds\/([^/]+)\/schedules\/([^/]+)\/runs$/, async ({ request, response, params }) => {
    const worldId = requireWorld(store, params[0]!)
    await access.assertUnlocked(worldId, request)
    if (!schedules.list(worldId).some((item) => item.id === params[1]!)) throw new HttpError(404, 'schedule_not_found', '计划不存在')
    writeJson(response, 200, { items: schedules.listRuns(params[1]!) })
  })
}

function requireWorld(store: SqliteStore, worldId: string): string {
  if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', 'World not found')
  return worldId
}

function scheduleError(cause: unknown): HttpError {
  const message = cause instanceof Error ? cause.message : '计划操作失败'
  return new HttpError(message === '计划不存在' ? 404 : 422, message === '计划不存在' ? 'schedule_not_found' : 'schedule_invalid', message)
}
