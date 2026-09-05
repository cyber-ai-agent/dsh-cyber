import type { JsonObject } from '@dsh-cyber/contracts'
import { WorldArtifactRepository, type SqliteStore } from '@dsh-cyber/persistence'

import { AgentRunFileEvidenceService } from '../services/agent-run-file-evidence.js'
import { WorldArtifactService } from '../services/world-artifact-service.js'
import type { WorldRootService } from '../services/world-root-service.js'

export interface ComposedArtifactServices {
  /** Bracketing seam for the character runtime. */
  runFileEvidence: AgentRunFileEvidenceService
  artifacts: WorldArtifactService
}

/**
 * The Artifact Center and the Host-owned run file evidence are one unit: the
 * recorder brackets a run inside the character runtime and the Artifact service
 * reads the same records when it decides what that run produced. Composing them
 * apart is what allowed a time-window guess to be stored as provenance.
 */
export function composeArtifactServices(
  store: SqliteStore,
  roots: WorldRootService,
  onChanged: (worldId: string, payload: JsonObject) => void,
): ComposedArtifactServices {
  const runFileEvidence = new AgentRunFileEvidenceService({ roots })
  return {
    runFileEvidence,
    artifacts: new WorldArtifactService({
      repository: new WorldArtifactRepository(store.database),
      roots,
      evidence: runFileEvidence,
      onChanged,
    }),
  }
}
