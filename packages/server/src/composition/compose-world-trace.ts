import { WorkSystemRepository, type SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository } from '../skills/skill-action-repository.js'
import { ContextSnapshotService } from '../services/context-snapshot-service.js'
import type { WorldArtifactService } from '../services/world-artifact-service.js'
import { WorldTraceService } from '../services/world-trace-service.js'

/**
 * Wires the world trace to the owners of what it reads.
 *
 * The trace never derives a task link or a context number itself: task links
 * come from the Work System's own `task_runs` repository, and per-run context
 * numbers come from the D4 snapshot service. Keeping that wiring here rather
 * than in the composition root is the same split `composeWorkSystem` and
 * `composeCompletion` already make, and it keeps `server.ts` inside its
 * composition-root line budget.
 */
export function composeWorldTrace(options: {
  store: SqliteStore
  actions: CharacterSkillActionRepository
  artifacts: WorldArtifactService
}): { worldTrace: WorldTraceService; contextSnapshots: ContextSnapshotService } {
  const contextSnapshots = new ContextSnapshotService(options.store)
  const worldTrace = new WorldTraceService({
    store: options.store,
    actions: options.actions,
    artifacts: options.artifacts,
    tasks: new WorkSystemRepository(options.store.database),
    contexts: contextSnapshots,
  })
  return { worldTrace, contextSnapshots }
}
