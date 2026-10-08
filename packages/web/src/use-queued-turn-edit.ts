import { useCallback, useRef } from 'react'
import { api } from './api.js'
import type { PendingChatTurn } from './chat-realtime.js'
import { composerDraftOwnerKey, composerDraftStore, type ComposerDraftContent } from './composer-draft-store.js'

/** Cancellation and draft restoration share one captured turn, never the visible owner. */
export function useQueuedTurnEdit({ demoMode, getTurn, removeDemoTurn, onCancelled, onError, onRestored }: {
  demoMode: boolean
  getTurn(id: string): PendingChatTurn | undefined
  removeDemoTurn(id: string): boolean
  onCancelled(id: string): void
  onError(message: string): void
  onRestored(ownerKey: string): void
}) {
  // Successful cancellations stay handled until unmount, including before React
  // commits the pending-turn update and while stale queue reads are in flight.
  const handledTurns = useRef(new Map<string, 'pending' | 'cancelled'>())
  const editingOwners = useRef(new Set<string>())

  const cancel = useCallback(async (turn: PendingChatTurn): Promise<void> => {
    if (demoMode) {
      if (!removeDemoTurn(turn.id)) throw new Error('这条消息已开始执行，无法撤回编辑。')
    } else {
      await api(`/api/worlds/${encodeURIComponent(turn.worldId)}/chat-queue/${encodeURIComponent(turn.serverQueueId ?? turn.id)}`, { method: 'DELETE' })
    }
    handledTurns.current.set(turn.id, 'cancelled')
    onCancelled(turn.id)
  }, [demoMode, onCancelled, removeDemoTurn])

  const cancelQueuedTurn = useCallback(async (id: string): Promise<void> => {
    const turn = getTurn(id)
    if (turn?.status !== 'queued' || handledTurns.current.has(id)) return
    handledTurns.current.set(id, 'pending')
    try { await cancel(turn) } catch (cause) {
      handledTurns.current.delete(id)
      onError(cause instanceof Error ? cause.message : '撤销排队消息失败')
    }
  }, [cancel, getTurn, onError])

  const editQueuedTurn = useCallback(async (id: string): Promise<void> => {
    const turn = getTurn(id)
    if (turn?.status !== 'queued' || handledTurns.current.has(id)) return
    const ownerKey = composerDraftOwnerKey(turn.worldId, turn.queueKey)
    if (editingOwners.current.has(ownerKey)) return
    const current = composerDraftStore.get(ownerKey)
    if (current.text.length > 0 || current.attachments.length > 0 || current.recalledMessage !== undefined) {
      onError('请先发送或清空当前草稿，再编辑排队消息。')
      return
    }
    const content: ComposerDraftContent = {
      text: turn.content ?? turn.title,
      attachments: (turn.attachments ?? []).map((attachment, index) => ({
        id: `recalled:${turn.id}:${index}`,
        name: attachment.name,
        mimeType: attachment.mimeType,
        byteLength: attachment.byteLength,
        status: 'ready',
        attachment: { ...attachment },
      })),
      ...(turn.modelProfileId === undefined ? {} : { modelProfileId: turn.modelProfileId }),
      ...(turn.reasoningEffort === undefined ? {} : { reasoningEffort: turn.reasoningEffort }),
    }
    handledTurns.current.set(id, 'pending')
    editingOwners.current.add(ownerKey)
    try {
      await cancel(turn)
      composerDraftStore.restoreCancelledTurn(ownerKey, current.revision, content)
      onRestored(ownerKey)
    } catch (cause) {
      handledTurns.current.delete(id)
      onError(cause instanceof Error ? cause.message : '撤销排队消息失败')
    } finally {
      editingOwners.current.delete(ownerKey)
    }
  }, [cancel, getTurn, onError, onRestored])

  const wasCancelled = useCallback((id: string) => handledTurns.current.get(id) === 'cancelled', [])
  return { cancelQueuedTurn, editQueuedTurn, wasCancelled }
}
