import type { WorkSession } from '@dsh-cyber/contracts'
import { api, ApiError } from './api.js'
import type { PendingChatTurn } from './chat-realtime.js'
import { chatSubmissionStore, type ChatSubmission } from './chat-submission-store.js'

interface ChatReceipt {
  session: WorkSession
  workTurnId?: string
  queueItem?: { id?: string; workTurnId?: string; status?: PendingChatTurn['status'] | 'completed' }
}

type DeliveryResult = { kind: 'accepted'; receipt: ChatReceipt } | { kind: 'failed'; permissionDenied: boolean } | { kind: 'in-flight' }
const sending = new Set<string>()

/** One transport attempt. The host's durable ingress key owns execution deduplication. */
export async function deliverChatSubmission(submission: ChatSubmission): Promise<DeliveryResult> {
  if (sending.has(submission.id)) return { kind: 'in-flight' }
  sending.add(submission.id)
  chatSubmissionStore.put({ ...submission, status: 'sending' })
  try {
    const receipt = await api<ChatReceipt>(`/api/worlds/${encodeURIComponent(submission.worldId)}/chat`, {
      method: 'POST', body: submission.body,
    })
    chatSubmissionStore.remove(submission.id)
    return { kind: 'accepted', receipt }
  } catch (cause) {
    const rejected = cause instanceof ApiError && [400, 401, 403, 404, 413, 422].includes(cause.status)
    const error = cause instanceof ApiError ? cause.message : '连接中断，服务端接收结果尚待确认。请恢复连接后重试提交。'
    chatSubmissionStore.put({ ...submission, status: rejected ? 'rejected' : 'uncertain', error })
    return { kind: 'failed', permissionDenied: cause instanceof ApiError && cause.code === 'owner_runtime_access_denied' }
  } finally {
    sending.delete(submission.id)
  }
}
