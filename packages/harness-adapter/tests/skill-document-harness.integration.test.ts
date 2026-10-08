import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { estimateTextTokens, type AgentRuntimeEvent, type AgentSkillDocuments, type EmployeeInstance, type EmployeeRevision } from '@dsh-cyber/contracts'
import { HarnessCompatibilityAdapter, PINNED_HARNESS_NATIVE_TOOL_SCHEMA_TOKENS, SKILL_DOCUMENT_TOOL_SCHEMA_RESERVE } from '../src/adapter.js'

it('loads skill text lazily through real Harness tools, rechecks revocation, and removes tools next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-harness-'))
  const requests: Array<Record<string, any>> = []
  const events: AgentRuntimeEvent[] = []
  const body = 'LAZY-SKILL-BODY: 开发前先建立测试基线。'
  const longBody = '首'.repeat(4_000) + 'MIDDLE-SKILL-SENTINEL' + '尾'.repeat(3_000)
  const longPages: Array<{ content: string; nextOffset?: number }> = []
  const server = createServer((req, res) => {
    void (async () => {
      const parts = []
      for await (const chunk of req) parts.push(chunk)
      requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')))
      const step = requests.length
      let tool = step === 1 ? { name: 'skills_list', arguments: '{}' }
        : step === 2 || step === 4 ? { name: 'skills_read', arguments: JSON.stringify({ skillId: 'dev-workflow' }) } : undefined
      if (step >= 7) {
        if (step === 7) tool = { name: 'skills_read', arguments: JSON.stringify({ skillId: 'dev-workflow' }) }
        else {
          const latest = requests.at(-1)!.messages.filter((message: any) => message.role === 'tool').at(-1)
          const content = typeof latest?.content === 'string' ? latest.content : (latest?.content ?? []).map((part: any) => part.text ?? '').join('')
          try {
            const page = JSON.parse(content) as { content: string; nextOffset?: number }
            longPages.push(page)
            if (page.nextOffset !== undefined) tool = { name: 'skills_read', arguments: JSON.stringify({ skillId: 'dev-workflow', offset: page.nextOffset }) }
          } catch { /* A pruning marker inside JSON proves the page was lost. */ }
        }
      }
      const envelope = { id: `skill-${step}`, object: 'chat.completion.chunk', created: 1_777_777_777, model: 'local-test' }
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `skill-call-${step}`, type: 'function', function: tool }] }
        : { role: 'assistant', content: '技能说明已按工具返回核验。' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })().catch(() => { res.statusCode = 500; res.end('local fixture failed') })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const employee: EmployeeInstance = { id: 'self', workspaceId: 'workspace-a', worldId: 'world-a', blueprintId: 'worker', blueprintVersion: 1, displayName: '本地员工', role: '开发', status: 'available', currentRevision: 1, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' }
  const revision: EmployeeRevision = { employeeId: employee.id, revision: 1, persona: '按需使用 skills_list 和 skills_read 查阅宿主提供的技能。', skillGrants: [], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: employee.createdAt }
  const read = vi.fn<AgentSkillDocuments['read']>(async (request) => ({ skillId: request.skillId, revision: 'v1', path: 'SKILL.md', content: body, totalChars: body.length, resources: [] }))
  const documents: AgentSkillDocuments = { actorId: employee.id, workspaceId: employee.workspaceId, worldId: employee.worldId, skills: [{ id: 'dev-workflow', displayName: '开发流程', summary: '建立基线，开发并验证。', revision: 'v1' }], read }
  // Even an ambient skill package is not discovered by the dedicated profile.
  await mkdir(join(root, '.agents', 'skills', 'ambient'), { recursive: true })
  await writeFile(join(root, '.agents', 'skills', 'ambient', 'SKILL.md'), 'AMBIENT-SKILL-MUST-NOT-LOAD')
  const adapter = new HarnessCompatibilityAdapter({
    stateRoot: root, provider: 'local-integration', model: 'local-test',
    inheritedEnvironment: { ...process.env, DSH_CYBER_LOCAL_TEST_KEY: 'local-test-only' },
    providerProfile: { route: 'local-integration', displayName: 'Loopback skills provider', api: 'openai-completions', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKeyEnv: 'DSH_CYBER_LOCAL_TEST_KEY', model: { id: 'local-test', name: 'Loopback model', contextWindow: 32_768, maxTokens: 512 } },
  })
  try {
    const base = { agent: employee, revision, conversationId: 'skill-session', history: [], observedThroughSequence: 0, prompt: '请先查阅开发流程技能，再告诉我第一步。', workspacePath: root, permissionMode: 'read-only' as const, onEvent: (event: AgentRuntimeEvent) => events.push(event) }
    await adapter.runTurn({ ...base, skillDocuments: documents })
    expect(requests).toHaveLength(3)
    expect(read).toHaveBeenCalledOnce()
    const definitions = requests[0]!.tools as Array<{ function: { name: string } }>
    expect(definitions.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(['skills_list', 'skills_read']))
    expect(definitions.map((tool) => tool.function.name)).not.toContain('skill')
    expect(estimateTextTokens(JSON.stringify(definitions)) - PINNED_HARNESS_NATIVE_TOOL_SCHEMA_TOKENS).toBeLessThanOrEqual(SKILL_DOCUMENT_TOOL_SCHEMA_RESERVE)
    expect(JSON.stringify(requests[0])).not.toContain(body)
    expect(JSON.stringify(requests[1])).not.toContain(body)
    expect(JSON.stringify(requests[2]!.messages)).toContain(body)
    expect(JSON.stringify(requests)).not.toMatch(/AMBIENT-SKILL-MUST-NOT-LOAD|\/skill-documents\/read|Bearer [a-f0-9]{64}/)
    expect(events.some((event) => event.kind === 'approval.requested')).toBe(false)
    expect(events.some((event) => event.kind === 'tool.completed' && String(event.metadata.toolOutput).includes('LAZY-SKILL-BODY'))).toBe(true)
    read.mockRejectedValue(new Error('/private/skills/secret grant revoked'))
    await adapter.runTurn({ ...base, prompt: '请再次读取开发流程。', skillDocuments: documents })
    expect(read).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(5)
    const latestResult = requests[4]!.messages.filter((message: { role: string }) => message.role === 'tool').at(-1)
    expect(JSON.stringify(latestResult)).toContain('授权已失效')
    expect(JSON.stringify(latestResult)).not.toContain('/private')
    await adapter.runTurn({ ...base, prompt: '这一轮没有技能授权。' })
    expect(requests).toHaveLength(6)
    expect(requests[5]!.tools.map((tool: any) => tool.function.name)).not.toContain('skills_read')
    read.mockImplementation(async (request) => {
      const offset = request.offset ?? 0
      const content = longBody.slice(offset, offset + (request.limit ?? 6000))
      const nextOffset = offset + content.length
      return { skillId: request.skillId, revision: 'v1', path: 'SKILL.md', content, totalChars: longBody.length, ...(nextOffset < longBody.length ? { nextOffset } : {}), resources: [] }
    })
    await adapter.runTurn({ ...base, prompt: '请分页读完整份开发说明，包括中部的标记。', skillDocuments: documents })
    expect(longPages.map((page) => page.content).join('')).toBe(longBody)
    expect(JSON.stringify(requests.slice(6))).toContain('MIDDLE-SKILL-SENTINEL')
    expect(JSON.stringify(events)).not.toMatch(/\/skill-documents\/read|Bearer [a-f0-9]{64}/)
  } finally {
    await adapter.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
