import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { estimateTextTokens, type AgentRuntimeEvent, type EmployeeInstance, type EmployeeRevision, type WorldDirectorySnapshot } from '@dsh-cyber/contracts'
import { HarnessCompatibilityAdapter, PINNED_HARNESS_NATIVE_TOOL_SCHEMA_TOKENS, WORLD_DIRECTORY_TOOL_SCHEMA_RESERVE } from '../src/adapter.js'

it('runs actual world directory tools in the pinned Harness and refreshes a persistent worker snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-world-directory-harness-'))
  const requests: Array<Record<string, any>> = []
  const events: AgentRuntimeEvent[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const parts = []
      for await (const chunk of req) parts.push(chunk)
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      requests.push(body)
      const toolRound = requests.length % 2 === 1
      const envelope = { id: `directory-${requests.length}`, object: 'chat.completion.chunk', created: 1_777_777_777, model: 'local-test' }
      const delta = toolRound
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `directory-call-${requests.length}`, type: 'function', function: { name: 'world_directory_search', arguments: JSON.stringify({ query: '研究' }) } }] }
        : { role: 'assistant', content: 'DIRECTORY-OK' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: toolRound ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })().catch(() => { res.statusCode = 500; res.end('local fixture failed') })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const employee: EmployeeInstance = {
    id: 'self', workspaceId: 'workspace-a', worldId: 'world-a', blueprintId: 'worker', blueprintVersion: 1,
    displayName: '本地员工', role: '开发', status: 'available', currentRevision: 1,
    createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z',
  }
  const revision: EmployeeRevision = { employeeId: employee.id, revision: 1, persona: '使用工具查阅真实名册。', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: employee.createdAt }
  const directory: WorldDirectorySnapshot = {
    actorId: employee.id, workspaceId: employee.workspaceId, worldId: employee.worldId, revision: 'roster-v1', availabilityKnown: true,
    members: [
      { characterId: 'self', displayName: '本地员工', role: '开发', characterRevision: 1, grantedSkillIds: [], availableSkillIds: [] },
      { characterId: 'colleague', displayName: '小林', role: '研究', characterRevision: 1, grantedSkillIds: [], availableSkillIds: [] },
    ],
  }
  const adapter = new HarnessCompatibilityAdapter({
    stateRoot: root, provider: 'local-integration', model: 'local-test',
    inheritedEnvironment: { ...process.env, DSH_CYBER_LOCAL_TEST_KEY: 'local-test-only' },
    providerProfile: { route: 'local-integration', displayName: 'Loopback directory provider', api: 'openai-completions', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKeyEnv: 'DSH_CYBER_LOCAL_TEST_KEY', model: { id: 'local-test', name: 'Loopback model', contextWindow: 32_768, maxTokens: 512 } },
  })
  try {
    const base = { agent: employee, revision, conversationId: 'directory-session', history: [], observedThroughSequence: 0, prompt: '谁负责研究？', workspacePath: root, permissionMode: 'read-only' as const, onEvent: (event: AgentRuntimeEvent) => events.push(event) }
    await adapter.runTurn({ ...base, worldDirectory: directory })
    expect(requests).toHaveLength(2)
    const definitions = requests[0]!.tools as Array<{ function: { name: string } }>
    expect(definitions.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['world_directory_list', 'world_directory_search', 'world_directory_get']))
    expect(estimateTextTokens(JSON.stringify(definitions)) - PINNED_HARNESS_NATIVE_TOOL_SCHEMA_TOKENS).toBeLessThanOrEqual(WORLD_DIRECTORY_TOOL_SCHEMA_RESERVE)
    expect(JSON.stringify(requests[1]!.messages)).toContain('小林')
    expect(events.some((event) => event.kind === 'approval.requested')).toBe(false)
    expect(events.find((event) => event.kind === 'tool.completed')?.metadata.toolOutput).toContain('小林')
    directory.members[1]!.displayName = '林舟'
    directory.revision = 'roster-v2'
    await adapter.runTurn({ ...base, prompt: '重新查一遍研究同事。', worldDirectory: directory })
    expect(requests).toHaveLength(4)
    const currentResult = requests[3]!.messages.filter((message: { role: string }) => message.role === 'tool').at(-1)
    expect(JSON.stringify(currentResult)).toContain('林舟')
    expect(JSON.stringify(currentResult)).not.toContain('小林')
  } finally {
    await adapter.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
