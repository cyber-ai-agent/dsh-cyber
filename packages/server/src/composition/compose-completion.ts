import type { SqliteStore } from '@dsh-cyber/persistence'
import { CompletionWorker } from '../services/completion-worker.js'
import { EmployeeConversationMemoryService } from '../services/employee-conversation-memory-service.js'
import type { WorldArtifactService } from '../services/world-artifact-service.js'

export function composeCompletionWorker(
  store: SqliteStore,
  artifacts: WorldArtifactService,
  memory: EmployeeConversationMemoryService = new EmployeeConversationMemoryService(store),
): CompletionWorker {
  return new CompletionWorker({
    store,
    handlers: new Map([[
      'world-artifact-publication',
      async (job) => {
        const employeeId = typeof job.payload.employeeId === 'string' ? job.payload.employeeId : undefined
        const workspacePath = typeof job.payload.workspacePath === 'string' ? job.payload.workspacePath : undefined
        if (employeeId === undefined || workspacePath === undefined) throw new Error('completion_job_payload_invalid')
        const contribution = await artifacts.publishAgentRun({
          workspaceId: job.workspaceId,
          worldId: job.worldId,
          employeeId,
          sessionId: job.sessionId,
          workTurnId: job.workTurnId,
          agentRunId: job.agentRunId,
          workspacePath,
        })
        // Memory is an employee-owned projection of already committed chat
        // facts. The source-message dedupe in the service makes this safe when
        // the durable completion job retries after a crash.
        await memory.rememberCompletedRun({
          employeeId,
          sessionId: job.sessionId,
          workTurnId: job.workTurnId,
          agentRunId: job.agentRunId,
          artifactRefs: contribution.artifactRefs,
        })
        return contribution
      },
    ]]),
  })
}
