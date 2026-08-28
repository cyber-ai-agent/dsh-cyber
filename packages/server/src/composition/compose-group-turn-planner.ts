import type { SqliteStore } from '@dsh-cyber/persistence'
import type { GroupTurnPlannerPort } from '@dsh-cyber/orchestration'

import type { ModelCredentialService } from '../services/model-credential-service.js'
import { ModelGroupTurnPlanner } from '../services/model-group-turn-planner.js'
import { ModelJsonCall } from '../services/model-json-call.js'

/**
 * The roster decision for a group turn.
 *
 * Routing runs before anyone speaks, so its timeout is the floor on how long
 * a group turn can appear frozen. The budget is deliberately far below a
 * conversational one: a slow or dead endpoint has to degrade to the
 * deterministic roster quickly rather than hold the room.
 */
export function composeGroupTurnPlanner(
  store: SqliteStore,
  credentials: ModelCredentialService,
): GroupTurnPlannerPort {
  return new ModelGroupTurnPlanner({
    store,
    call: new ModelJsonCall({ credentials, timeoutMs: 6_000, maxOutputTokens: 512 }),
  })
}
