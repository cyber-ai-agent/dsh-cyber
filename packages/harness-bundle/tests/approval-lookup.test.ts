import { describe, expect, it } from 'vitest'
import { latestApprovalRequestId } from '../src/index.js'

const ask = (id: string, toolName = 'bash', callId?: string) => ({ id, toolName, ...(callId === undefined ? {} : { callId }) })

describe('current approval lookup', () => {
  it('uses the synchronous session event projection', () => {
    expect(latestApprovalRequestId({ toolName: 'bash' }, [ask('a')])).toBe('a')
  })
  it('chooses the newest matching question', () => {
    expect(latestApprovalRequestId({ toolName: 'bash' }, [ask('old'), ask('new')])).toBe('new')
  })
  it('rejects mismatched tool and call identities', () => {
    expect(latestApprovalRequestId({ toolName: 'bash', callId: 'call-2' }, [
      ask('a', 'bash', 'call-1'), ask('b', 'read_file', 'call-2'),
    ])).toBeUndefined()
  })
})
