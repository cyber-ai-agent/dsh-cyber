import type { SqliteStore } from '@dsh-cyber/persistence'
import { CompletionWorker } from '../services/completion-worker.js'
import type { WorldArtifactService } from '../services/world-artifact-service.js'

export function composeCompletionWorker(store: SqliteStore, artifacts: WorldArtifactService): CompletionWorker {
  return new CompletionWorker({
    store,
    handlers: new Map([[
      'world-artifact-publication',
      async (job) => {
        const employeeId = typeof job.payload.employeeId === 'string' ? job.payload.employeeId : undefined
        const workspacePath = typeof job.payload.workspacePath === 'string' ? job.payload.workspacePath : undefined
        if (employeeId === undefined || workspacePath === undefined) throw new Error('completion_job_payload_invalid')
        return artifacts.publishAgentRun({
          workspaceId: job.workspaceId,
          worldId: job.worldId,
          employeeId,
          sessionId: job.sessionId,
          workTurnId: job.workTurnId,
          agentRunId: job.agentRunId,
          workspacePath,
        })
      },
    ]]),
  })
}
