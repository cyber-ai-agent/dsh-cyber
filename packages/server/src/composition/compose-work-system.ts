import type { Router } from '../http/router.js'
import { registerWorkSystemRoutes } from '../routes/work-system-routes.js'
import {
  ModelConversationTaskIntentClassifier,
  type ConversationTaskIntentPort,
} from '../services/conversation-task-intent-classifier.js'
import { ConversationTaskIntentService } from '../services/conversation-task-intent-service.js'
import type { GroupTaskCollaborationService } from '../services/group-task-collaboration-service.js'
import type { ModelCredentialService } from '../services/model-credential-service.js'
import { ModelJsonCall } from '../services/model-json-call.js'
import { WorkSystemService } from '../services/work-system-service.js'
import type { WorldAccessService } from '../services/world-access-service.js'
import type { WorldRuntimeService } from '../world-runtime-service.js'
import type { SqliteStore } from '@dsh-cyber/persistence'

/**
 * The Work System and the one boundary that lets a conversation reach it.
 *
 * The intent decision sits here, beside the service that records the task,
 * rather than in the composition root: it is the same split `composeWorldTrace`
 * and `composeCompletion` make, and it keeps `server.ts` inside its
 * composition-root line budget.
 *
 * The classifier's timeout is deliberately far below a conversational one. It
 * is one extra call per owner chat message, made in parallel with the turn, and
 * a slow or dead endpoint has to give up long before the turn does — the answer
 * is only ever a draft the owner may run later, never something the reply waits
 * on. Its own prompt asks for a category and two short strings, so the token
 * budget is small enough that this stays cheap next to the turn it accompanies.
 */
export function composeWorkSystem(options: {
  store: SqliteStore
  credentials: ModelCredentialService
  groupTasks: GroupTaskCollaborationService
  router: Router
  worldAccess: WorldAccessService
  worldRuntime: WorldRuntimeService
  /** Tests and CI pass a deterministic stub so no run calls a cloud model. */
  intentClassifier?: ConversationTaskIntentPort
}): { work: WorkSystemService; taskIntent: ConversationTaskIntentService } {
  const work = new WorkSystemService({ store: options.store, groupTasks: options.groupTasks })
  registerWorkSystemRoutes(options.router, { store: options.store, work, access: options.worldAccess })
  // Runs at open, next to the store's own turn recovery: a task left `running`
  // by the previous process can never finish on its own.
  const recovered = work.recoverAfterRestart()
  if (recovered.failed > 0) console.warn(`[dsh-cyber] 上次运行中断了 ${recovered.failed} 个执行中的任务，已标记为失败，可重新执行。`)
  const taskIntent = new ConversationTaskIntentService({
    store: options.store,
    work,
    runtime: options.worldRuntime,
    classifier: options.intentClassifier ?? new ModelConversationTaskIntentClassifier({
      store: options.store,
      call: new ModelJsonCall({ credentials: options.credentials, timeoutMs: 8_000, maxOutputTokens: 512, jsonResponseMode: 'prompt-only' }),
    }),
  })
  return { work, taskIntent }
}
