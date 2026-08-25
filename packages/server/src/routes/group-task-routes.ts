import type { WorkSessionCollaborationMode } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { HttpError } from '../http/errors.js'
import { readJson, requiredEnum } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import type { GroupTaskCollaborationService } from '../services/group-task-collaboration-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'

export interface GroupTaskRoutesDependencies {
  store: SqliteStore
  worldAccess: WorldAccessService
  groupTasks: GroupTaskCollaborationService
}

export function registerGroupTaskRoutes(router: Router, dependencies: GroupTaskRoutesDependencies): void {
  const { store, worldAccess, groupTasks } = dependencies

  router.route('PATCH', /^\/api\/sessions\/([^/]+)\/collaboration-mode$/, async ({ request, response, params }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess.assertUnlocked(session.worldId, request)
    if (session.kind !== 'group' || session.status !== 'open') {
      throw new HttpError(409, 'session_mode_change_unavailable', '只有开放中的群聊可以切换协作模式')
    }
    const body = await readJson(request)
    const collaborationMode = requiredEnum<WorkSessionCollaborationMode>(body, 'collaborationMode', ['discussion', 'task'])
    try {
      writeJson(response, 200, { session: groupTasks.setMode(session.id, collaborationMode) })
    } catch (error) {
      throw new HttpError(409, 'session_mode_change_unavailable', error instanceof Error ? error.message : '协作模式暂不可切换')
    }
  })

  router.get(/^\/api\/turns\/([^/]+)\/collaboration-plan$/, async ({ request, response, params }) => {
    const turn = store.getWorkTurn(params[0]!)
    if (turn === undefined) throw new HttpError(404, 'turn_not_found', 'Turn not found')
    await worldAccess.assertUnlocked(turn.worldId, request)
    const plan = groupTasks.getPlanForTurn(turn.worldId, turn.id)
    if (plan === undefined) throw new HttpError(404, 'plan_not_found', 'Task collaboration plan not found')
    writeJson(response, 200, await groupTasks.presentPlan(plan))
  })

  // Compatibility alias for the current workbench summary. The turn-scoped
  // endpoint above remains canonical because one session can contain many
  // task turns.
  router.get(/^\/api\/sessions\/([^/]+)\/task-plan$/, async ({ request, response, params }) => {
    const session = store.getSession(params[0]!)
    if (session === undefined) throw new HttpError(404, 'session_not_found', 'Session not found')
    await worldAccess.assertUnlocked(session.worldId, request)
    const plan = groupTasks.getPlanForSession(session.worldId, session.id)
    // A task-mode session is valid before its first user task. Return an empty
    // projection instead of making the workbench poll a noisy 404.
    writeJson(response, 200, plan === undefined ? { plan: null, skillLabels: {} } : await groupTasks.presentPlan(plan))
  })
}
