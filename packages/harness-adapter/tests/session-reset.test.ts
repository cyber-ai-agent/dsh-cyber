import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { EmployeeInstance, EmployeeRevision } from '@dsh-cyber/contracts'
import { HarnessCompatibilityAdapter } from '../src/adapter.js'

it('resets only one conversation and reserves its lane until close completes', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'cyber-session-reset-'))
  const agent = { id: 'a', workspaceId: 'w', worldId: 'world', blueprintId: 'b', blueprintVersion: 1,
    displayName: '测试', role: '测试', status: 'available', currentRevision: 1,
    createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' } satisfies EmployeeInstance
  const revision = { employeeId: 'a', revision: 1, persona: '测试', skillGrants: [], capabilityGrants: [],
    modelPolicy: {}, reason: 'test', createdAt: agent.createdAt } satisfies EmployeeRevision
  let finishB!: () => void
  let finishClose!: () => void
  const closed: string[] = []
  const started: string[] = []
  const sessions: string[] = []
  let instancesA = 0
  const adapter = new HarnessCompatibilityAdapter({ stateRoot, runtimeFactory(spec) {
    const id = spec.conversationId!
    const generation = id === 'A' ? ++instancesA : 1
    return {
      async run(sessionId) {
        started.push(id)
        if (id === 'A') sessions.push(sessionId)
        if (id === 'B') await new Promise<void>((resolve) => { finishB = resolve })
        return { finalResponse: id, notifications: [] }
      },
      async close() {
        closed.push(id)
        if (id === 'A' && generation === 1) await new Promise<void>((resolve) => { finishClose = resolve })
      },
    }
  } })
  const request = (id: string) => ({ employee: agent, revision, conversationId: id,
    history: [], observedThroughSequence: 0, prompt: id, workspacePath: stateRoot })
  try {
    await adapter.runEmployeeTurn(request('A'))
    const b = adapter.runEmployeeTurn(request('B'))
    await expect.poll(() => started.includes('B')).toBe(true)
    const reset = adapter.resetSession(agent.id, 'A')
    await expect.poll(() => closed).toEqual(['A'])
    const nextA = adapter.runEmployeeTurn(request('A'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(instancesA).toBe(1)
    expect(closed).toEqual(['A'])
    finishClose()
    await reset
    await expect(nextA).resolves.toMatchObject({ finalResponse: 'A' })
    expect(sessions[1]).not.toBe(sessions[0])
    finishB()
    await expect(b).resolves.toMatchObject({ finalResponse: 'B' })
  } finally {
    finishClose?.()
    finishB?.()
    await adapter.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})

it('keeps a failed close quarantined instead of restarting queued work in the damaged process', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'cyber-session-reset-failure-'))
  const agent = { id: 'a', workspaceId: 'w', worldId: 'world', blueprintId: 'b', blueprintVersion: 1,
    displayName: '测试', role: '测试', status: 'available', currentRevision: 1,
    createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' } satisfies EmployeeInstance
  const revision = { employeeId: 'a', revision: 1, persona: '测试', skillGrants: [], capabilityGrants: [],
    modelPolicy: {}, reason: 'test', createdAt: agent.createdAt } satisfies EmployeeRevision
  let rejectClose!: (error: Error) => void
  let closes = 0
  let runs = 0
  const adapter = new HarnessCompatibilityAdapter({ stateRoot, runtimeFactory: () => ({
    async run() { runs += 1; return { finalResponse: 'ok', notifications: [] } },
    async close() {
      if (++closes === 1) await new Promise<void>((_resolve, reject) => { rejectClose = reject })
    },
  }) })
  const request = { employee: agent, revision, conversationId: 'A', history: [],
    observedThroughSequence: 0, prompt: 'test', workspacePath: stateRoot }
  try {
    await adapter.runEmployeeTurn(request)
    const reset = adapter.resetSession('a', 'A')
    const failedReset = expect(reset).rejects.toThrow('close failed')
    await expect.poll(() => closes).toBe(1)
    const queued = adapter.runEmployeeTurn(request)
    const failedQueued = expect(queued).rejects.toThrow('close failed')
    rejectClose(new Error('close failed'))
    await Promise.all([failedReset, failedQueued])
    await expect(adapter.runEmployeeTurn(request)).rejects.toThrow('recovery failed')
    expect(runs).toBe(1)
    await adapter.resetSession('a', 'A')
    await expect(adapter.runEmployeeTurn(request)).resolves.toMatchObject({ finalResponse: 'ok' })
    expect(runs).toBe(2)
  } finally {
    await adapter.close()
    await rm(stateRoot, { recursive: true, force: true })
  }
})
