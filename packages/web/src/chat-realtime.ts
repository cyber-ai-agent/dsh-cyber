import type { WorkMessage } from '@dsh-cyber/contracts'

export type PendingChatTurnStatus = 'queued' | 'running' | 'failed'

export interface PendingChatTurn {
  id: string
  queueKey: string
  worldId: string
  employeeIds: string[]
  title: string
  status: PendingChatTurnStatus
  createdAt: string
  sessionId?: string
  error?: string
}

export interface StreamingChatReply {
  id: string
  queueKey: string
  worldId: string
  sessionId: string
  employeeId: string
  clientTurnId: string
  traceTurnId: string
  content: string
  createdAt: string
}

/**
 * Serializes model turns only inside the same conversation. Different
 * conversation keys are intentionally allowed to run in parallel.
 */
export class ChatTurnQueue {
  readonly #tails = new Map<string, Promise<void>>()

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.#tails.set(key, current)
    void current.finally(() => {
      if (this.#tails.get(key) === current) this.#tails.delete(key)
    }).catch(() => undefined)
    return current
  }

  isPending(key: string): boolean {
    return this.#tails.has(key)
  }
}

export function messageClientTurnId(message: WorkMessage): string | undefined {
  const value = message.metadata.clientTurnId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Builds the visible conversation without exposing reasoning/tool events.
 * A running assistant bubble is inserted directly after the user turn it
 * belongs to, while later follow-ups remain visible as queued user messages.
 */
export function mergeChatTimeline(
  durableMessages: WorkMessage[],
  outboxMessages: WorkMessage[],
  pendingTurns: PendingChatTurn[],
  streamingReplies: StreamingChatReply[],
): WorkMessage[] {
  const timeline = [...durableMessages]
  const orderedTurns = [...pendingTurns].sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  for (const turn of orderedTurns) {
    let ownerIndex = timeline.findIndex((message) =>
      message.senderKind === 'owner' && messageClientTurnId(message) === turn.id,
    )
    if (ownerIndex < 0) {
      const optimistic = outboxMessages.find((message) => messageClientTurnId(message) === turn.id)
      if (optimistic !== undefined) {
        timeline.push(optimistic)
        ownerIndex = timeline.length - 1
      }
    }

    const hasDurableAssistant = timeline.some((message) =>
      message.senderKind === 'employee' &&
      message.metadata.streaming !== true &&
      messageClientTurnId(message) === turn.id,
    )
    if (!hasDurableAssistant) {
      const replies = streamingReplies
        .filter((reply) => reply.clientTurnId === turn.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      for (const reply of replies) {
        if (timeline.some((message) => message.id === reply.id)) continue
        const insertAt = Math.max(ownerIndex, lastTurnMessageIndex(timeline, turn.id)) + 1
        timeline.splice(insertAt, 0, streamingMessage(reply, timeline[insertAt - 1]?.sequence ?? 0))
      }
    }

    if (turn.status === 'failed' && turn.error !== undefined) {
      const failureId = `local-turn-failure-${turn.id}`
      if (!timeline.some((message) => message.id === failureId)) {
        const insertAt = Math.max(ownerIndex, lastTurnMessageIndex(timeline, turn.id)) + 1
        timeline.splice(insertAt, 0, {
          id: failureId,
          sessionId: turn.sessionId ?? `pending-${turn.id}`,
          sequence: (timeline[insertAt - 1]?.sequence ?? 0) + 1,
          senderId: 'system',
          senderKind: 'system',
          kind: 'system',
          content: `发送失败：${turn.error}`,
          metadata: { productNotice: true, clientTurnId: turn.id, localTurnFailure: true },
          createdAt: turn.createdAt,
        })
      }
    }
  }

  for (const optimistic of outboxMessages) {
    const clientTurnId = messageClientTurnId(optimistic)
    const represented = clientTurnId !== undefined && timeline.some((message) =>
      message.senderKind === 'owner' && messageClientTurnId(message) === clientTurnId,
    )
    if (!represented) timeline.push(optimistic)
  }

  return timeline
}

function lastTurnMessageIndex(messages: WorkMessage[], clientTurnId: string): number {
  let index = -1
  for (let current = 0; current < messages.length; current += 1) {
    if (messageClientTurnId(messages[current]!) === clientTurnId) index = current
  }
  return index
}

function streamingMessage(reply: StreamingChatReply, previousSequence: number): WorkMessage {
  return {
    id: reply.id,
    sessionId: reply.sessionId,
    sequence: previousSequence + 1,
    senderId: reply.employeeId,
    senderKind: 'employee',
    kind: 'assistant',
    content: reply.content,
    metadata: {
      streaming: true,
      clientTurnId: reply.clientTurnId,
      traceTurnId: reply.traceTurnId,
      displayTime: new Date(reply.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    },
    createdAt: reply.createdAt,
  }
}
