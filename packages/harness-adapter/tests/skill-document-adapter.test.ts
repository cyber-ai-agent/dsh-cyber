import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planContextBudget } from '@dsh-cyber/contracts'
import type { AgentSkillDocuments, AgentTurnRequest, EmployeeInstance } from '@dsh-cyber/contracts'
import { HarnessCompatibilityAdapter, SKILL_DOCUMENT_TOOL_SCHEMA_RESERVE, type HarnessRuntime } from '../src/adapter.js'

const roots: string[] = []
const adapters: HarnessCompatibilityAdapter[] = []
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-adapter-'))
  roots.push(root)
  const agent: EmployeeInstance = { id: 'a', workspaceId: 'ws', worldId: 'w', blueprintId: 'worker', blueprintVersion: 1, displayName: '角色', role: '开发', status: 'available', currentRevision: 1, createdAt: '2026-09-01', updatedAt: '2026-09-01' }
  const documents: AgentSkillDocuments = { actorId: 'a', workspaceId: 'ws', worldId: 'w', skills: [], read: vi.fn() }
  const request: AgentTurnRequest = { agent, revision: { employeeId: 'a', revision: 1, persona: '开发', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: '2026-09-01' }, conversationId: 'c', history: [], observedThroughSequence: 0, prompt: 'hello', workspacePath: root }
  const run = vi.fn<HarnessRuntime['run']>(async () => ({ finalResponse: 'ok', notifications: [] }))
  const close = vi.fn(async () => undefined)
  const runtimeFactory = vi.fn(() => ({ run, close }))
  const adapter = new HarnessCompatibilityAdapter({ stateRoot: root, runtimeFactory, nativeToolSchemaTokens: 0, nativeSystemOverheadTokens: 0, nativeTurnContextTokens: 0 })
  adapters.push(adapter)
  return { adapter, documents, request, run, close, runtimeFactory }
}
describe('skill document adapter boundary', () => {
  it('propagates the host provider unchanged, budgets schema and resets when tools disappear', async () => {
    const f = await fixture()
    const result = await f.adapter.runTurn({ ...f.request, skillDocuments: f.documents })
    expect(f.run.mock.calls[0]?.[4]).toBe(f.documents)
    expect(result.contextUsage?.nativeReservedTokens).toBe(SKILL_DOCUMENT_TOOL_SCHEMA_RESERVE)
    await f.adapter.runTurn({ ...f.request, skillDocuments: f.documents })
    expect(f.runtimeFactory).toHaveBeenCalledTimes(1)
    await f.adapter.runTurn(f.request)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.runtimeFactory).toHaveBeenCalledTimes(2)
    expect(f.run.mock.calls[2]?.[4]).toBeUndefined()
  })
  it('rejects cross-character, world and workspace providers before creating a lane', async () => {
    const f = await fixture()
    for (const key of ['actorId', 'worldId', 'workspaceId']) {
      await expect(f.adapter.runTurn({ ...f.request, skillDocuments: { ...f.documents, [key]: 'other' } })).rejects.toThrow('不匹配')
    }
    expect(f.runtimeFactory).not.toHaveBeenCalled()
  })
  it('includes skill schema costs in fixed-input rejection before runtime startup', async () => {
    const f = await fixture()
    await expect(f.adapter.runTurn({ ...f.request, skillDocuments: f.documents, contextBudget: { ...planContextBudget({ contextWindow: 4096, maxOutputTokens: 1024 }), inputBudgetTokens: 500, historyTokens: 0 } })).rejects.toThrow()
    expect(f.runtimeFactory).not.toHaveBeenCalled()
  })
})
