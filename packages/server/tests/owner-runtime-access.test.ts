import { describe, expect, it } from 'vitest'

import {
  OwnerRuntimeAccessDeniedError,
  OwnerRuntimeAccessService,
} from '../src/services/owner-runtime-access-service.js'

const PROMPT = '读取 C:\\Users\\Public\\report.txt'

function grantFor(service: OwnerRuntimeAccessService) {
  return service.issue({
    worldId: 'world-1',
    sessionId: 'session-1',
    employeeIds: ['employee-1'],
    clientTurnId: 'turn-1',
    prompt: PROMPT,
    confirmed: true,
  })
}

describe('owner runtime access grants', () => {
  it('refuses to issue without an explicit risk confirmation', () => {
    const service = new OwnerRuntimeAccessService()
    expect(() => service.issue({
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
      confirmed: false,
    })).toThrow(OwnerRuntimeAccessDeniedError)
  })

  it('refuses a grant that is not bound to a specific turn and character', () => {
    const service = new OwnerRuntimeAccessService()
    expect(() => service.issue({ worldId: 'world-1', sessionId: 'session-1', employeeIds: [], clientTurnId: 'turn-1', prompt: PROMPT, confirmed: true }))
      .toThrow(OwnerRuntimeAccessDeniedError)
    expect(() => service.issue({ worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-1'], clientTurnId: '  ', prompt: PROMPT, confirmed: true }))
      .toThrow(OwnerRuntimeAccessDeniedError)
  })

  it('spends a grant exactly once', () => {
    const service = new OwnerRuntimeAccessService()
    const grant = grantFor(service)
    const input = { grantId: grant.id, worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-1'], clientTurnId: 'turn-1', prompt: PROMPT }
    expect(service.consume(input)).toBe(true)
    // Replaying the same request must not elevate a second turn.
    expect(service.consume(input)).toBe(false)
  })

  it('refuses a different prompt even when world, character and client turn match', () => {
    const service = new OwnerRuntimeAccessService()
    const grant = grantFor(service)
    expect(service.consume({
      grantId: grant.id,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: '删除另一个目录',
    })).toBe(false)
  })

  it('refuses a grant borrowed by another world, turn or character', () => {
    const service = new OwnerRuntimeAccessService()
    expect(service.consume({
      grantId: grantFor(service).id,
      worldId: 'world-1',
      sessionId: 'session-2',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
    })).toBe(false)
    expect(service.consume({
      grantId: grantFor(service).id,
      worldId: 'world-2',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
    })).toBe(false)
    expect(service.consume({
      grantId: grantFor(service).id,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-2',
      prompt: PROMPT,
    })).toBe(false)
    expect(service.consume({
      grantId: grantFor(service).id,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-2'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
    })).toBe(false)
  })

  it('does not elevate the other characters of a group turn', () => {
    const service = new OwnerRuntimeAccessService()
    const grant = service.issue({
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
      confirmed: true,
    })
    expect(service.consume({
      grantId: grant.id,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1', 'employee-2'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
    })).toBe(false)
  })

  it('expires', () => {
    let now = 1_000
    const service = new OwnerRuntimeAccessService({ ttlMs: 100, now: () => now })
    const grant = grantFor(service)
    now += 101
    expect(service.consume({
      grantId: grant.id,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
    })).toBe(false)
  })

  it('refuses a request that carries no grant at all', () => {
    const service = new OwnerRuntimeAccessService()
    expect(service.consume({
      grantId: undefined,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      clientTurnId: 'turn-1',
      prompt: PROMPT,
    })).toBe(false)
  })
})
