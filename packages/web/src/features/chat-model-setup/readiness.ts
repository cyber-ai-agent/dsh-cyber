import type { ConversationModelReadiness } from '@dsh-cyber/contracts'
import { api } from '../../api.js'

/** A read-only host check; never makes a model request or tests a credential. */
export function readConversationModelReadiness(worldId: string, employeeIds: readonly string[], modelProfileId?: string, signal?: AbortSignal): Promise<ConversationModelReadiness> {
  return api<ConversationModelReadiness>(`/api/worlds/${encodeURIComponent(worldId)}/model-readiness`, {
    method: 'POST',
    body: JSON.stringify({ employeeIds, ...(modelProfileId === undefined ? {} : { modelProfileId }) }),
    ...(signal === undefined ? {} : { signal }),
  })
}
