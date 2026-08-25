import { describe, expect, it } from 'vitest'

import type { WorkMessage } from '@dsh-cyber/contracts'

import { groupMessagesByRun } from '../src/services/world-trace-service.js'

let sequence = 0

function message(metadata: Record<string, unknown>): WorkMessage {
  sequence += 1
  return {
    id: `message-${sequence}`,
    sessionId: 'session-1',
    sequence,
    senderId: 'employee-1',
    senderKind: 'employee',
    kind: 'tool-call',
    content: '调用工具：read_file',
    metadata: metadata as WorkMessage['metadata'],
    createdAt: new Date(Date.UTC(2026, 7, 24, 0, 0, sequence)).toISOString(),
  }
}

describe('groupMessagesByRun', () => {
  it('gives each run only the messages that belong to it', () => {
    const a = message({ agentRunId: 'run-a' })
    const b = message({ agentRunId: 'run-b' })
    const grouped = groupMessagesByRun([a, b])
    expect(grouped.get('run-a')).toEqual([a])
    expect(grouped.get('run-b')).toEqual([b])
  })

  it('keeps claiming a message by traceTurnId as well as agentRunId', () => {
    // The two identifiers can differ, and the per-run filter this replaced
    // accepted either, so both must still resolve to the message.
    const both = message({ agentRunId: 'run-a', traceTurnId: 'turn-1' })
    const grouped = groupMessagesByRun([both])
    expect(grouped.get('run-a')).toEqual([both])
    expect(grouped.get('turn-1')).toEqual([both])
  })

  it('does not duplicate a message whose two identifiers are equal', () => {
    const same = message({ agentRunId: 'run-a', traceTurnId: 'run-a' })
    expect(groupMessagesByRun([same]).get('run-a')).toEqual([same])
  })

  it('ignores messages that claim no run', () => {
    expect(groupMessagesByRun([message({}), message({ agentRunId: '' })]).size).toBe(0)
  })

  it('stays linear in the number of messages', () => {
    // The whole point: materialization used to hand every run the entire world
    // transcript, so cost grew with runs x messages.
    const messages = Array.from({ length: 20_000 }, (_, index) => message({ agentRunId: `run-${index % 2_000}` }))
    const grouped = groupMessagesByRun(messages)
    expect(grouped.size).toBe(2_000)
    for (const bucket of grouped.values()) expect(bucket).toHaveLength(10)
  })
})
