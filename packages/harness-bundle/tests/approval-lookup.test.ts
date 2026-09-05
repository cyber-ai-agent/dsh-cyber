import { describe, expect, it } from 'vitest'
import { SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { latestApprovalRequestId } from '../src/index.js'

function session(events: Array<{ type: string; data: Record<string, unknown> }>): Pick<Session, 'seq' | 'eventAt'> {
  return {
    seq: SessionLogOffset(events.length),
    eventAt: (seq) => events[Number(seq)] as SessionEvent | undefined,
  }
}
const ask = (id: string, toolName = 'bash') => ({ type: 'approval/asked', data: { id, toolName } })

describe('rc.1 approval lookup', () => {
  it('uses seq/eventAt without a Session.events array', () => {
    expect(latestApprovalRequestId({ agent: { session: session([ask('a')]) }, toolName: 'bash' })).toBe('a')
  })
  it('does not resurrect an approval from a previous turn', () => {
    expect(latestApprovalRequestId({ agent: { session: session([ask('old'), { type: 'turn/start', data: {} }]) }, toolName: 'bash' })).toBeUndefined()
  })
  it('rejects settled and mismatched questions', () => {
    expect(latestApprovalRequestId({ agent: { session: session([
      ask('a'), { type: 'approval/decided', data: { id: 'a', outcome: 'rejected' } }, ask('b', 'read_file'),
    ]) }, toolName: 'bash' })).toBeUndefined()
  })
})
