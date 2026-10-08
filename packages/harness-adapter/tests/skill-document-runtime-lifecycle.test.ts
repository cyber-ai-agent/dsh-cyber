import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSkillDocuments, AgentTurnRequest } from '@dsh-cyber/contracts'
import { HarnessCompatibilityAdapter } from '../src/adapter.js'

const runtime = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ finalResponse: 'ok', notifications: [] })),
  request: vi.fn(async (_method: string, _params: unknown) => ({})),
  close: vi.fn(async () => undefined),
}))
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({ DeepSeekHarness: class {
  client = { request: runtime.request }
  start = runtime.start
  session() { return { run: runtime.run } }
  close = runtime.close
} }))

const roots: string[] = []
const adapters: HarnessCompatibilityAdapter[] = []
beforeEach(() => {
  runtime.start.mockReset().mockResolvedValue(undefined)
  runtime.run.mockReset().mockResolvedValue({ finalResponse: 'ok', notifications: [] })
  runtime.request.mockReset().mockResolvedValue({})
  runtime.close.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skills-lifecycle-'))
  roots.push(root)
  const adapter = new HarnessCompatibilityAdapter({ stateRoot: root })
  adapters.push(adapter)
  const documents: AgentSkillDocuments = { actorId: 'a', workspaceId: 'ws', worldId: 'w', skills: [{ id: 'skill', displayName: '技能', summary: '', revision: 'v1' }], read: vi.fn(async () => ({ skillId: 'skill', revision: 'v1', path: 'SKILL.md', content: 'body', totalChars: 4, resources: [] })) }
  const request: AgentTurnRequest = { agent: { id: 'a', workspaceId: 'ws', worldId: 'w', blueprintId: 'worker', blueprintVersion: 1, displayName: '角色', role: '开发', status: 'available', currentRevision: 1, createdAt: '2026-09-01', updatedAt: '2026-09-01' }, revision: { employeeId: 'a', revision: 1, persona: '开发', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: '2026-09-01' }, conversationId: 'c', agentRunId: 'run', history: [], observedThroughSequence: 0, prompt: 'hello', workspacePath: root, skillDocuments: documents }
  return { adapter, request, documents }
}
function latestBinding(): { endpoint: string; token: string } {
  return runtime.request.mock.calls.find(([method, params]) => method === 'skill-documents/set' && (params as any).endpoint)?.[1] as { endpoint: string; token: string }
}
function readBinding(binding: { endpoint: string; token: string }) {
  return fetch(binding.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.token}` }, body: JSON.stringify({ skillId: 'skill' }) })
}
it('does not relaunch an uninitialized SDK client during failed-start cleanup', async () => {
  const f = await fixture()
  runtime.start.mockRejectedValue(new Error('original startup failure'))
  await expect(f.adapter.runTurn(f.request)).rejects.toThrow('original startup failure')
  expect(runtime.request).not.toHaveBeenCalled()
})
it('revokes the bridge on successful and failed run completion and clears worker bindings', async () => {
  const f = await fixture()
  await f.adapter.runTurn(f.request)
  await expect(readBinding(latestBinding())).rejects.toThrow()
  expect(runtime.request.mock.calls.at(-1)).toEqual(['skill-documents/set', { binding: null }, 1000])
  runtime.request.mockClear()
  runtime.run.mockRejectedValue(new Error('run failed'))
  await expect(f.adapter.runTurn(f.request)).rejects.toThrow('run failed')
  await expect(readBinding(latestBinding())).rejects.toThrow()
  expect(runtime.request.mock.calls.at(-1)).toEqual(['skill-documents/set', { binding: null }, 1000])
})
it('revokes bridge reads immediately when a live run is aborted', async () => {
  const f = await fixture()
  let finish!: (value: { finalResponse: string; notifications: [] }) => void
  runtime.run.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  runtime.close.mockImplementation(async () => { finish?.({ finalResponse: '', notifications: [] }) })
  const turn = f.adapter.runTurn(f.request).catch((error: unknown) => error)
  await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledOnce())
  const binding = latestBinding()
  expect((await readBinding(binding)).status).toBe(200)
  await f.adapter.abortRun('run')
  await expect(readBinding(binding)).rejects.toThrow()
  expect(await turn).toBeInstanceOf(Error)
  expect(f.documents.read).toHaveBeenCalledOnce()
})
