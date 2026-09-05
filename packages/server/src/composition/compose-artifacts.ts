import type { JsonObject } from '@dsh-cyber/contracts'
import { WorldArtifactRepository, type SqliteStore } from '@dsh-cyber/persistence'

import { AgentRunFileEvidenceService } from '../services/agent-run-file-evidence.js'
import { SavedReplyDocumentService } from '../services/saved-reply-document-service.js'
import { WorldArtifactService } from '../services/world-artifact-service.js'
import type { WorldRootService } from '../services/world-root-service.js'

export interface ComposedArtifactServices {
  /** Bracketing seam for the character runtime. */
  runFileEvidence: AgentRunFileEvidenceService
  artifacts: WorldArtifactService
  /** Owner-initiated "keep this reply"; publishes, never attributes a Run. */
  savedReplyDocuments: SavedReplyDocumentService
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
  const artifacts = new WorldArtifactService({
    repository: new WorldArtifactRepository(store.database),
    roots,
    evidence: runFileEvidence,
    onChanged,
  })
  return {
    runFileEvidence,
    artifacts,
    // Composed here, beside the evidence reader, so the one path that publishes
    // without any Run behind it sits next to the one that decides Run grades.
    savedReplyDocuments: new SavedReplyDocumentService({ store, artifacts }),
  }
}
