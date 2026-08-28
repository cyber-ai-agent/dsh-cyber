import type { SqliteStore } from '@dsh-cyber/persistence'
import type { GroupTurnPlannerPort } from '@dsh-cyber/orchestration'

import type { ModelCredentialService } from '../services/model-credential-service.js'
import { ModelGroupTurnPlanner } from '../services/model-group-turn-planner.js'
import { ModelJsonCall } from '../services/model-json-call.js'
import { PreparedGroupTurnPlanner } from '../services/prepared-group-turn-planner.js'

const PLANNERS = new WeakMap<object, PreparedGroupTurnPlanner>()

/**
 * The roster decision for a group turn.
 *
 * Routing runs before anyone speaks, so its timeout is the floor on how long
 * a group turn can appear frozen. The budget is deliberately far below a
 * conversational one: a slow or dead endpoint has to degrade to the
 * deterministic roster quickly rather than hold the room.
 *
 * The prepared wrapper lets ingress persist that decision before queueing and
 * re-seed it after restart, so execution does not pay for a second planner
 * call or reserve lanes for characters that will never speak.
 */
export function composeGroupTurnPlanner(
  store: SqliteStore,
  credentials: ModelCredentialService,
  override?: GroupTurnPlannerPort,
): PreparedGroupTurnPlanner {
  const planner = new PreparedGroupTurnPlanner(override ?? new ModelGroupTurnPlanner({
    store,
    call: new ModelJsonCall({ credentials, timeoutMs: 6_000, maxOutputTokens: 512 }),
  }))
  PLANNERS.set(store, planner)
  return planner
}

/**
 * Server routes and the queue composition are created after the planner. A
 * store-scoped registry keeps their planning boundary explicit without making
 * the top-level server composition file grow another cross-cutting argument.
 * WeakMap keeps tests/multiple local servers isolated and does not retain a
 * closed store.
 */
export function preparedGroupTurnPlannerFor(store: object): PreparedGroupTurnPlanner | undefined {
  return PLANNERS.get(store)
}
