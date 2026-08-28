import { describe, expect, it } from 'vitest'
import type { AgentTurnRequest, WorkMessage } from '@dsh-cyber/contracts'

import {
  contextSnapshotSequence,
  lastDurableObservation,
} from '../src/services/employee-observation-runtime.js'

function message(input: Partial<WorkMessage> & Pick<WorkMessage, 'id' | 'sequence' | 'senderId' | 'senderKind' | 'kind' | 'content'>): WorkMessage {
  return {
    sessionId: 'session-1',
    metadata: {},
    createdAt: `2026-08-28T00:00:${String(input.sequence).padStart(2, '0')}.000Z`,
    ...input,
  }
}

describe('durable employee observation cursors', () => {
  it('does not infer that a later-finishing speaker saw an earlier peer in the same concurrent wave', () => {
    const messages: WorkMessage[] = [
      message({ id: 'u1', sequence: 9, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '一起看下', metadata: { workTurnId: 'turn-1' } }),
      message({ id: 'b1', sequence: 10, senderId: 'b', senderKind: 'employee', kind: 'assistant', content: 'B 的结论', metadata: { contextObservedThroughSequence: 9 } }),
      // A commits after B, but both started from sequence 9. A must replay B on
      // its next turn rather than trusting its own later message sequence 11.
      message({ id: 'a1', sequence: 11, senderId: 'a', senderKind: 'employee', kind: 'assistant', content: 'A 的结论', metadata: { contextObservedThroughSequence: 9 } }),
    ]

    expect(lastDurableObservation(messages, 'a')).toBe(9)
    expect(lastDurableObservation(messages, 'b')).toBe(9)
  })

  it('uses the current user message as the run snapshot boundary instead of racing assistant commits', () => {
    const messages: WorkMessage[] = [
      message({ id: 'u1', sequence: 9, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '上一轮', metadata: { workTurnId: 'turn-1' } }),
      message({ id: 'b1', sequence: 10, senderId: 'b', senderKind: 'employee', kind: 'assistant', content: 'B 的结论' }),
      message({ id: 'u2', sequence: 12, senderId: 'owner', senderKind: 'owner', kind: 'user', content: '新任务', metadata: { workTurnId: 'turn-2' } }),
      // Another speaker may commit while this run is still being scheduled.
      message({ id: 'b2', sequence: 13, senderId: 'b', senderKind: 'employee', kind: 'assistant', content: 'B 本轮先完成' }),
    ]
    const request = {
      agent: { id: 'a' },
      conversationId: 'session-1',
      workTurnId: 'turn-2',
      history: [],
    } as unknown as AgentTurnRequest

    expect(contextSnapshotSequence(messages, request)).toBe(12)
  })

  it('falls back to the supplied history boundary when a WorkTurn message is unavailable', () => {
    const request = {
      agent: { id: 'a' },
      conversationId: 'session-1',
      history: [
        { role: 'user', sequence: 4, speakerId: 'owner', speakerName: '用户', content: '旧消息', createdAt: '' },
        { role: 'assistant', sequence: 7, speakerId: 'b', speakerName: 'B', content: '结论', createdAt: '' },
      ],
    } as unknown as AgentTurnRequest

    expect(contextSnapshotSequence([], request)).toBe(7)
  })
})
