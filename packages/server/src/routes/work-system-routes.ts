import {
  parseCreateWorkTask,
  parseReviewDecision,
  WorkSystemContractError,
  type WorkTaskStatus,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { readJson } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { WorkSystemService, WorkTaskListScope } from '../services/work-system-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import { requireWorldAcceptingWork } from '../services/world-work-guard.js'

const TASK_STATUSES: readonly WorkTaskStatus[] = ['draft','planning','ready','running','waiting-approval','waiting-review','changes-requested','completed','failed','cancelled','recovery-required']

export function registerWorkSystemRoutes(router: Router, dependencies: { store: SqliteStore; work: WorkSystemService; access: WorldAccessService }): void {
  const { store, work, access } = dependencies
  router.get(/^\/api\/worlds\/([^/]+)\/tasks$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    const world = store.getWorld(worldId)
    if (world === undefined) throw new HttpError(404, 'world_not_found', '世界不存在')
    await access.assertUnlocked(worldId, request)
    // No filter is the default view: everything except the cancelled tasks,
    // which stay reachable through `cancelled` or `all`.
    const raw = url.searchParams.get('status')
    const scope: WorkTaskListScope | undefined = raw === null ? undefined : raw === 'all' ? 'all' : TASK_STATUSES.find((item) => item === raw)
    if (raw !== null && scope === undefined) throw new HttpError(422, 'task_status_invalid', '任务状态无效')
    writeJson(response, 200, { items: work.list(worldId, scope) })
  })

  router.post(/^\/api\/worlds\/([^/]+)\/tasks$/, async ({ request, response, params }) => {
    const worldId = params[0]!
    const world = requireWorldAcceptingWork(store, worldId)
    await access.assertUnlocked(worldId, request)
    const body = await readJson(request)
    const input = contract(() => parseCreateWorkTask(body))
    writeJson(response, 201, { task: work.create({ workspaceId: world.workspaceId, worldId, ...input }) })
  })

  router.get(/^\/api\/tasks\/([^/]+)$/, async ({ request, response, params }) => {
    const detail = safeDetail(work, params[0]!)
    await access.assertUnlocked(detail.task.worldId, request)
    writeJson(response, 200, detail)
  })

  router.post(/^\/api\/tasks\/([^/]+)\/execute$/, async ({ request, response, params }) => {
    const detail = safeDetail(work, params[0]!)
    requireWorldAcceptingWork(store, detail.task.worldId)
    await access.assertUnlocked(detail.task.worldId, request)
    const body = await readJson(request)
    const employeeIds = stringArray(body.employeeIds, '任务角色')
    const coordinatorEmployeeId = typeof body.coordinatorEmployeeId === 'string' && body.coordinatorEmployeeId.trim() ? body.coordinatorEmployeeId.trim() : undefined
    const result = await work.execute(detail.task.id, { employeeIds, ...(coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId }) })
    writeJson(response, 200, result)
  })

  // Cancel, not delete: the task keeps its history and stays readable here, it
  // only leaves the default list. Unlike execute this starts no work, so an
  // archived world may still be tidied; a task an execution is holding refuses
  // with a 409 instead of racing it.
  router.post(/^\/api\/tasks\/([^/]+)\/cancel$/, async ({ request, response, params }) => {
    const detail = safeDetail(work, params[0]!)
    await access.assertUnlocked(detail.task.worldId, request)
    writeJson(response, 200, work.cancel(detail.task.id))
  })

  router.post(/^\/api\/tasks\/([^/]+)\/deliverables$/, async ({ request, response, params }) => {
    const detail = safeDetail(work, params[0]!)
    await access.assertUnlocked(detail.task.worldId, request)
    const body = await readJson(request)
    const deliverable = work.submitDeliverable({
      taskId: detail.task.id,
      taskRunId: text(body.taskRunId, 'taskRunId'),
      submittedByEmployeeId: text(body.submittedByEmployeeId, 'submittedByEmployeeId'),
      artifactId: text(body.artifactId, 'artifactId'),
      artifactVersionId: positiveInteger(body.artifactVersionId, 'artifactVersionId'),
      title: text(body.title, 'title'),
      summary: text(body.summary, 'summary'),
      evidenceRefs: stringArray(body.evidenceRefs ?? [], 'evidenceRefs'),
    })
    writeJson(response, 201, { deliverable })
  })

  router.post(/^\/api\/deliverables\/([^/]+)\/reviews$/, async ({ request, response, params }) => {
    const task = work.taskForDeliverable(params[0]!)
    if (task === undefined) throw new HttpError(404, 'deliverable_not_found', '交付不存在')
    await access.assertUnlocked(task.worldId, request)
    const body = await readJson(request)
    const input = contract(() => parseReviewDecision(body))
    const result = work.review(params[0]!, input)
    writeJson(response, 201, result)
  })

  router.get(/^\/api\/employees\/([^/]+)\/current-work$/, async ({ request, response, params }) => {
    const employee = store.getEmployee(params[0]!)
    if (employee === undefined) throw new HttpError(404, 'employee_not_found', '角色不存在')
    await access.assertUnlocked(employee.worldId, request)
    writeJson(response, 200, { items: work.currentWork(employee.id) })
  })
}

function contract<T>(operation: () => T): T { try { return operation() } catch (error) { if (error instanceof WorkSystemContractError) throw new HttpError(422, error.code, error.message); throw error } }
function safeDetail(work: WorkSystemService, id: string) { try { return work.detail(id) } catch { throw new HttpError(404, 'task_not_found', '任务不存在') } }
function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, 'work_system_contract_invalid', `${field} 不能为空`); return value.trim() }
function positiveInteger(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new HttpError(422, 'work_system_contract_invalid', `${field} 必须是正整数`); return value }
function stringArray(value: unknown, field: string): string[] { if (!Array.isArray(value)) throw new HttpError(422, 'work_system_contract_invalid', `${field} 必须是数组`); const result = [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]; if (field === '任务角色' && result.length < 1) throw new HttpError(422, 'work_system_contract_invalid', '任务角色至少需要一名'); return result }
