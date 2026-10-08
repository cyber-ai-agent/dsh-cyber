import { describe, expect, it } from 'vitest'

import type { WorkMessage } from '@dsh-cyber/contracts'

import {
  ChatTurnQueue,
  hasDurableTurnFailure,
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

  it('supports explicit promotion and removal of queued work', async () => {
    const queue = new ChatTurnQueue()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    void queue.enqueue('lane', async () => { order.push('running'); await gate }, 'running')
    void queue.enqueue('lane', async () => { order.push('second') }, 'second')
    void queue.enqueue('lane', async () => { order.push('third') }, 'third')
    expect(queue.promote('lane', 'third')).toBe(true)
    expect(queue.remove('second')).toBe(true)
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['running', 'third'])
  })
})

describe('mergeChatTimeline', () => {
  it('keeps queued follow-ups out of the transcript until they start', () => {
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
    ])
    expect(timeline[1]?.metadata.streaming).toBe(true)

    const running = mergeChatTimeline([first, followUp], [], pending.map((turn) => turn.id === 'turn-2' ? { ...turn, status: 'running' } : turn), streaming)
    expect(running.map((message) => message.content)).toEqual([
      '先分析问题',
      '正在流式返回的答案',
      '补充一个约束',
    ])
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


describe('durable failure reconciliation', () => {
  const turn: PendingChatTurn = { id: 'turn-1', worldId: 'world-1', queueKey: 'direct:a', employeeIds: ['a'], title: 'A', status: 'failed', error: '临时失败', createdAt: '2026-10-08T00:00:00.000Z', sessionId: 'session-1', workTurnId: 'work-1' }
  const notice: WorkMessage = { id: 'failure-1', sessionId: 'session-1', sequence: 2, senderId: 'system', senderKind: 'system', kind: 'system', content: '本次处理未完成：安全提示', createdAt: turn.createdAt, metadata: { productNotice: true, control: 'failure', status: 'failed', clientTurnId: turn.id, workTurnId: turn.workTurnId! } }

  it('keeps one durable notice instead of a local duplicate or an obsolete stream', () => {
    const owner = ownerMessage(turn.id, '原消息', 1)
    const stream: StreamingChatReply = { id: 'stream-1', queueKey: turn.queueKey, worldId: turn.worldId, sessionId: 'session-1', employeeId: 'a', clientTurnId: turn.id, traceTurnId: 'trace-1', workTurnId: 'work-1', agentRunId: 'run-1', content: '尚未完成的流式内容', createdAt: turn.createdAt }
    expect(mergeChatTimeline([owner, notice], [], [turn], [stream])).toEqual([owner, notice])
    expect(mergeChatTimeline([owner, notice], [], [], [])).toEqual([owner, notice])
  })

  it('requires matching session and turn, and never treats a Stop notice as failure', () => {
    expect(hasDurableTurnFailure([notice], turn)).toBe(true)
    expect(hasDurableTurnFailure([notice], { id: turn.id, sessionId: turn.sessionId })).toBe(true)
    expect(hasDurableTurnFailure([notice], { ...turn, workTurnId: 'other-turn' })).toBe(false)
    expect(hasDurableTurnFailure([notice], { ...turn, sessionId: 'other-session' })).toBe(false)
    expect(hasDurableTurnFailure([{ ...notice, metadata: { ...notice.metadata, control: 'stop' } }], turn)).toBe(false)
  })
})
