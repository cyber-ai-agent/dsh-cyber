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
  registerWorkSystemRoutes(options.router, { store: options.store, work: service, access: options.worldAccess })
  return service
}
