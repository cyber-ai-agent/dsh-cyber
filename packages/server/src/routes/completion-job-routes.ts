import type { CompletionJobStatus } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import type { Router } from '../http/router.js'
import { writeJson } from '../http/response.js'
import type { WorldAccessService } from '../services/world-access-service.js'

const STATUSES: readonly CompletionJobStatus[] = ['pending', 'running', 'retrying', 'completed', 'failed', 'cancelled']

export function registerCompletionJobRoutes(router: Router, dependencies: {
  store: SqliteStore
  access: WorldAccessService
  wake(): void
}): void {
  const { store, access, wake } = dependencies

  router.get(/^\/api\/worlds\/([^/]+)\/completion-jobs$/, async ({ request, response, params, url }) => {
    const worldId = params[0]!
    if (store.getWorld(worldId) === undefined) throw new HttpError(404, 'world_not_found', '世界不存在')
    await access.assertUnlocked(worldId, request)
    const rawStatus = url.searchParams.get('status')
    const status = rawStatus === null ? undefined : STATUSES.find((item) => item === rawStatus)
    if (rawStatus !== null && status === undefined) throw new HttpError(422, 'completion_job_status_invalid', '产物整理状态无效')
    writeJson(response, 200, { items: store.listCompletionJobs(worldId, status) })
  })

  router.get(/^\/api\/completion-jobs\/([^/]+)$/, async ({ request, response, params }) => {
    const job = store.getCompletionJob(params[0]!)
    if (job === undefined) throw new HttpError(404, 'completion_job_not_found', '产物整理任务不存在')
    await access.assertUnlocked(job.worldId, request)
    writeJson(response, 200, { job })
  })

  router.post(/^\/api\/completion-jobs\/([^/]+)\/retry$/, async ({ request, response, params }) => {
    const job = store.getCompletionJob(params[0]!)
    if (job === undefined) throw new HttpError(404, 'completion_job_not_found', '产物整理任务不存在')
    await access.assertUnlocked(job.worldId, request)
    const updated = store.requeueCompletionJob(job.id)
    wake()
    writeJson(response, 200, { job: updated })
  })
}
