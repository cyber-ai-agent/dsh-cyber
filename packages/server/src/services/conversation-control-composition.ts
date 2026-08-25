import type { ConversationOrchestrator } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { registerConversationQueueRoutes } from '../routes/conversation-queue-routes.js'
import type { Router } from '../http/router.js'
import type { WorldAccessService } from './world-access-service.js'
import type { TurnAwareApprovalContinuationService } from './turn-aware-approval-continuation-service.js'
import type { EmployeeActivityProjectionService } from './employee-activity-projection-service.js'
import type { WorldTraceService } from './world-trace-service.js'
import type { RuntimeStreamHub } from '../streams/runtime-stream-hub.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'
import { ConversationQueueService } from './conversation-queue-service.js'

export function composeConversationControl(options: {
  store: SqliteStore
  router: Router
  worldAccess: WorldAccessService
  orchestrator: ConversationOrchestrator
  continuations: TurnAwareApprovalContinuationService
  employeeActivity: EmployeeActivityProjectionService
  worldRuntime: WorldRuntimeService
  worldTrace: WorldTraceService
  runtimeStreamHub: RuntimeStreamHub
}): { queue: ConversationQueueService; start(): void; close(): Promise<void> } {
  const queue = new ConversationQueueService({
    store: options.store,
    orchestrator: options.orchestrator,
    continuations: options.continuations,
    onSettled: async (entry) => {
      for (const employeeId of entry.employeeIds) options.employeeActivity.project(employeeId)
      options.worldRuntime.publishCurrent(entry.worldId)
      const trace = await options.worldTrace.list(entry.worldId, { limit: 50 })
      options.runtimeStreamHub.publishTrace(entry.worldId, trace.items.filter((item) => item.workTurnId === entry.workTurnId))
    },
  })
  registerConversationQueueRoutes(options.router, {
    store: options.store,
    worldAccess: options.worldAccess,
    queue,
  })
  return {
    queue,
    start() { queue.start() },
    close() { return queue.close() },
  }
}
