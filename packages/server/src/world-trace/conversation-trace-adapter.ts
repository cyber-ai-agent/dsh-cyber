import type { JsonObject, WorkMessage, WorldTraceEntry } from '@dsh-cyber/contracts'

import { numberField, runtimeIdentity, stringField, traceId, type WorldTraceAdapter } from './trace-adapter.js'

export class ConversationTraceAdapter implements WorldTraceAdapter<'conversation'> {
  readonly kind = 'conversation' as const

  adapt({ value }: Extract<import('./trace-adapter.js').WorldTraceFact, { kind: 'conversation' }>): WorldTraceEntry[] {
    const { message, session, worldId } = value
    if (message.kind === 'tool-call' || message.kind === 'tool-result') return []
    const metadata = message.metadata as JsonObject & Record<string, unknown>
    // Carry the WorkTurn identity through conversation entries too, so the
    // trace can fold a turn's request, runs and tools into one card.
    const workTurnId = stringField(metadata, 'workTurnId')
    const base = {
      worldId,
      actorId: message.senderId,
      sessionId: session.id,
      ...(workTurnId === undefined ? {} : { workTurnId }),
      sourceKind: 'conversation' as const,
      sourceId: message.id,
      sourceSequence: message.sequence,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    }

    if (message.kind === 'user') {
      const participantCount = Array.isArray(metadata.participantIds) ? metadata.participantIds.length : undefined
      return [{
        ...base,
        id: traceId('conversation-user', message.id),
        category: 'task',
        status: 'pending',
        summary: '用户提交了新的会话请求',
        ...(participantCount === undefined ? {} : { detail: `已发送给 ${participantCount} 名角色` }),
      }]
    }

    if (message.kind === 'system') {
      return [{
        ...base,
        id: traceId('conversation-system', message.id),
        category: metadata.peerConversation === true ? 'collaboration' : 'system',
        status: 'info',
        summary: metadata.peerConversation === true ? '角色协作目标已建立' : '系统记录了会话事件',
      }]
    }

    const source = stringField(metadata, 'source') ?? 'conversation'
    const sourceSessionId = stringField(metadata, 'sourceSessionId') ?? session.id
    const sourceSequence = numberField(metadata, 'sourceSequence')
    const traceTurnId = stringField(metadata, 'traceTurnId')
    const kind = message.kind === 'reasoning' ? 'assistant.reasoning' : 'assistant.message'
    return [{
      ...base,
      id: runtimeIdentity({
        kind,
        source,
        sourceSessionId,
        ...(sourceSequence === undefined ? {} : { sourceSequence }),
        ...(traceTurnId === undefined ? {} : { traceTurnId }),
        ...(message.kind === 'reasoning' ? { content: message.content } : {}),
      }),
      category: 'agent',
      status: message.kind === 'reasoning' ? 'info' : 'success',
      summary: message.kind === 'reasoning' ? '角色生成了推理摘要' : '角色已生成最终回复',
      ...(message.kind === 'reasoning' ? { detail: message.content } : {}),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
    }]
  }
}
