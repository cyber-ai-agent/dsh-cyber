import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSkillDocuments } from '@dsh-cyber/contracts'
import { createSkillDocumentBridge, type SkillDocumentBridge } from '../src/skill-document-bridge.js'

const bridges: SkillDocumentBridge[] = []
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.close())) })
function documents(): AgentSkillDocuments {
  return {
    actorId: 'a', worldId: 'w', workspaceId: 'ws',
    skills: [{ id: 'skill', displayName: '技能', summary: '摘要', revision: 'v1' }],
    read: vi.fn(async (request) => ({ skillId: request.skillId, revision: 'v1', path: request.path ?? 'SKILL.md', content: 'body', totalChars: 4, resources: [] })),
  }
}
async function start(provider = documents()) {
  const bridge = await createSkillDocumentBridge(provider, 'session')
  bridges.push(bridge)
  return bridge
}
function read(bridge: SkillDocumentBridge, body: unknown = { skillId: 'skill' }, headers: Record<string, string> = {}) {
  return fetch(bridge.binding.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.binding.token}`, ...headers }, body: JSON.stringify(body) })
}
describe('per-run skill document bridge', () => {
  it('calls the live provider for every read and immediately reflects revocation', async () => {
    const provider = documents()
    const bridge = await start(provider)
    expect(await (await read(bridge)).json()).toMatchObject({ content: 'body' })
    expect(await (await read(bridge)).json()).toMatchObject({ content: 'body' })
    expect(provider.read).toHaveBeenCalledTimes(2)
    vi.mocked(provider.read).mockRejectedValue(new Error('/private/secret/path token=do-not-show'))
    const response = await read(bridge)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toMatch(/secret|private|do-not-show/)
    expect(bridge.binding).not.toHaveProperty('read')
  })
  it('isolates tokens, skill IDs and HTTP host/path/method/origin', async () => {
    const provider = documents()
    const bridge = await start(provider)
    const other = await start()
    expect((await read(bridge, undefined, { Authorization: `Bearer ${other.binding.token}` })).status).toBe(403)
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(bridge.binding.endpoint, { method: 'POST', headers: { Host: 'attacker.invalid', 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.binding.token}` } }, (response) => { response.resume(); resolve(response.statusCode!) })
      request.on('error', reject)
      request.end(JSON.stringify({ skillId: 'skill' }))
    })
    expect(invalidHost).toBe(403)
    expect((await read(bridge, undefined, { Origin: 'http://attacker.invalid' })).status).toBe(403)
    expect((await read(bridge, { skillId: 'outside' })).status).toBe(403)
    expect((await read(bridge, { skillId: 'skill', path: '../secret' })).status).toBe(403)
    expect((await fetch(bridge.binding.endpoint)).status).toBe(403)
    expect((await fetch(bridge.binding.endpoint + '/other', { method: 'POST' })).status).toBe(403)
    expect(provider.read).not.toHaveBeenCalled()
  })
  it('bounds request/result bytes and only forwards whitelisted error codes', async () => {
    const provider = documents()
    const bridge = await start(provider)
    expect((await read(bridge, { skillId: 'x'.repeat(5000) })).status).toBe(413)
    expect(provider.read).not.toHaveBeenCalled()
    vi.mocked(provider.read).mockResolvedValue({ skillId: 'skill', revision: 'v1', path: 'SKILL.md', content: 'x'.repeat(12001), totalChars: 12001, resources: [] })
    expect((await read(bridge)).status).toBe(403)
    vi.mocked(provider.read).mockRejectedValue(new Error('skill_document_not_text'))
    expect(await (await read(bridge)).json()).toEqual({ error: { code: 'skill_document_not_text' } })
  })
  it('closes connections, revokes pending reads and supports idempotent teardown', async () => {
    let resolveRead!: (value: Awaited<ReturnType<AgentSkillDocuments['read']>>) => void
    const provider = documents()
    vi.mocked(provider.read).mockImplementation(() => new Promise((resolve) => { resolveRead = resolve }))
    const bridge = await start(provider)
    const pending = read(bridge).catch(() => null)
    await vi.waitFor(() => expect(provider.read).toHaveBeenCalledOnce())
    await bridge.close()
    resolveRead({ skillId: 'skill', revision: 'v1', path: 'SKILL.md', content: 'late', totalChars: 4, resources: [] })
    expect(await pending).toBeNull()
    await bridge.close()
    await expect(read(bridge)).rejects.toThrow()
  })
})
