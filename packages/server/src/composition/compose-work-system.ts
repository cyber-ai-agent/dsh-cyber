import type { Router } from '../http/router.js'
import { registerWorkSystemRoutes } from '../routes/work-system-routes.js'
import type { GroupTaskCollaborationService } from '../services/group-task-collaboration-service.js'
import { WorkSystemService } from '../services/work-system-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { SqliteStore } from '@dsh-cyber/persistence'

export function composeWorkSystem(options: {
  store: SqliteStore
  groupTasks: GroupTaskCollaborationService
  router: Router
  worldAccess: WorldAccessService
}): WorkSystemService {
  const service = new WorkSystemService({ store: options.store, groupTasks: options.groupTasks })
  // Runs at open, next to the store's own turn recovery: a task left `running`
  // by the previous process can never finish on its own.
  const recovered = service.recoverAfterRestart()
  if (recovered.failed > 0) console.warn(`[dsh-cyber] 上次运行中断了 ${recovered.failed} 个执行中的任务，已标记为失败，可重新执行。`)
  registerWorkSystemRoutes(options.router, { store: options.store, work: service, access: options.worldAccess })
  return service
}
