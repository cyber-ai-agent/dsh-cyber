import { describe, expect, it } from 'vitest'

import type { WorkMessage } from '@dsh-cyber/contracts'

import {
  ChatTurnQueue,
  mergeChatTimeline,
  type PendingChatTurn,
  type StreamingChatReply,
} from '../src/chat-realtime.js'

function ownerMessage(clientTurnId: string, content: string, sequence: number): WorkMessage {
  return {
    id: `owner-${clientTurnId}`,
    sessionId: 'session-1',
    sequence,
    senderId: 'owner',
    senderKind: 'owner',
    kind: 'user',
    content,
    metadata: { clientTurnId },
    createdAt: `2026-08-24T00:00:0${sequence}.000Z`,
  }
}

describe('ChatTurnQueue', () => {
  it('serializes one conversation while allowing another conversation to run', async () => {
    const queue = new ChatTurnQueue()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = queue.enqueue('direct:a', async () => {
      order.push('a1:start')
      await firstGate
      order.push('a1:end')
    })
    const second = queue.enqueue('direct:a', async () => { order.push('a2') })
    const otherConversation = queue.enqueue('direct:b', async () => { order.push('b1') })

    await otherConversation
    expect(order).toEqual(['a1:start', 'b1'])
    expect(queue.isPending('direct:a')).toBe(true)

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['a1:start', 'b1', 'a1:end', 'a2'])
    expect(queue.isPending('direct:a')).toBe(false)
  })
})

describe('mergeChatTimeline', () => {
  it('keeps the streaming reply before a queued follow-up', () => {
    const first = ownerMessage('turn-1', '先分析问题', 1)
    const followUp = ownerMessage('turn-2', '补充一个约束', 2)
    const pending: PendingChatTurn[] = [
      { id: 'turn-1', queueKey: 'direct:a', worldId: 'world-1', employeeIds: ['a'], title: '与 A 对话', status: 'running', createdAt: '2026-08-24T00:00:01.000Z', sessionId: 'session-1' },
      { id: 'turn-2', queueKey: 'direct:a', worldId: 'world-1', employeeIds: ['a'], title: '与 A 对话', status: 'queued', createdAt: '2026-08-24T00:00:02.000Z', sessionId: 'session-1' },
    ]
    const streaming: StreamingChatReply[] = [{
      id: 'stream-trace-1',
      queueKey: 'direct:a',
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeId: 'a',
      clientTurnId: 'turn-1',
      traceTurnId: 'trace-1',
      content: '正在流式返回的答案',
      createdAt: '2026-08-24T00:00:01.500Z',
    }]

    const timeline = mergeChatTimeline([first], [followUp], pending, streaming)

    expect(timeline.map((message) => message.content)).toEqual([
      '先分析问题',
      '正在流式返回的答案',
      '补充一个约束',
    ])
    expect(timeline[1]?.metadata.streaming).toBe(true)
  })

  it('prefers a durable assistant reply over its transient stream', () => {
    const first = ownerMessage('turn-1', '先分析问题', 1)
    const durableReply: WorkMessage = {
      id: 'assistant-1',
      sessionId: 'session-1',
      sequence: 2,
      senderId: 'a',
      senderKind: 'employee',
      kind: 'assistant',
      content: '最终答案',
      metadata: { clientTurnId: 'turn-1' },
      createdAt: '2026-08-24T00:00:03.000Z',
    }
    const pending: PendingChatTurn[] = [{ id: 'turn-1', queueKey: 'direct:a', worldId: 'world-1', employeeIds: ['a'], title: '与 A 对话', status: 'running', createdAt: '2026-08-24T00:00:01.000Z', sessionId: 'session-1' }]
    const streaming: StreamingChatReply[] = [{ id: 'stream-trace-1', queueKey: 'direct:a', worldId: 'world-1', sessionId: 'session-1', employeeId: 'a', clientTurnId: 'turn-1', traceTurnId: 'trace-1', content: '临时内容', createdAt: '2026-08-24T00:00:01.500Z' }]

    const timeline = mergeChatTimeline([first, durableReply], [], pending, streaming)

    expect(timeline.map((message) => message.content)).toEqual(['先分析问题', '最终答案'])
  })
})
