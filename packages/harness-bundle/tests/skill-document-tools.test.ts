import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SKILL_TOOL_RESULT_MAX_CHARS, SkillDocumentTools } from '../src/skill-document-tools.js'

function fixture() {
  const definitions = new Map<string, any>()
  const disposers: Array<() => void> = []
  const listeners = new Map<string, (payload: any) => void>()
  const root = { id: 'session', session: { id: 'session' } }
  const agents = new Map<string, any>([['session', root]])
  const owners = new Map<string, any>()
  const ctx = {
    on: (name: string, callback: (payload: any) => void) => { listeners.set(name, callback) },
    agents: { list: () => [...agents.values()], get: (id: string) => agents.get(id), isOwnedBy: (id: string, owner: any) => owners.get(id) === owner },
    tools: { register: (tool: any) => { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } },
    effect: (callback: () => () => void) => { disposers.push(callback()) },
  } as unknown as Context
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ skillId: 'a', revision: 'v1', path: 'SKILL.md', content: 'BODY', totalChars: 4, resources: [] }))
  const tools = new SkillDocumentTools(ctx, fetchImpl)
  const binding = { workspaceId: 'workspace', worldId: 'world', actorId: 'actor', sessionId: 'session', endpoint: 'http://127.0.0.1:45678/skill-documents/read', token: 'a'.repeat(64), skills: [{ id: 'a', displayName: '技能', summary: '摘要', revision: 'v1', body: 'PRIVATE', absolutePath: '/private' }] }
  const exec = { agent: root, signal: new AbortController().signal }
  return { tools, binding, definitions, fetchImpl, exec, agents, owners, listeners, root, dispose: () => disposers.forEach((dispose) => dispose()) }
}
describe('worker skill tools', () => {
  it('installs descriptor-only discovery and bounded host-backed reads', async () => {
    const f = fixture()
    expect(f.definitions.size).toBe(0)
    f.tools.update(f.binding)
    const list = await f.definitions.get('skills_list').execute({}, f.exec)
    expect(JSON.stringify(list)).not.toMatch(/PRIVATE|private|45678|aaaaaaa/)
    expect(f.fetchImpl).not.toHaveBeenCalled()
    expect(await f.definitions.get('skills_read').execute({ skillId: 'a' }, f.exec)).toMatchObject({ content: 'BODY' })
    expect(JSON.parse(f.fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({ skillId: 'a', path: 'SKILL.md', offset: 0, limit: 6000, resourceOffset: 0 })
    expect(f.definitions.size).toBe(2)
    expect(() => f.tools.update({ ...f.binding, actorId: 'other' })).toThrow('不能切换')
    f.dispose()
    expect(f.definitions.size).toBe(0)
  })
  it('rejects missing or different sessions, undiscovered skills and scope injection', async () => {
    const f = fixture()
    f.tools.update(f.binding)
    await expect(f.definitions.get('skills_list').execute({}, { ...f.exec, agent: { session: { id: 'other' } } })).rejects.toThrow()
    await expect(f.definitions.get('skills_read').execute({ skillId: 'b' }, f.exec)).rejects.toThrow('未获授权')
    await expect(f.definitions.get('skills_read').execute({ skillId: 'a', worldId: 'other' }, f.exec)).rejects.toThrow()
    expect(f.fetchImpl).not.toHaveBeenCalled()
    f.tools.update({ binding: null })
    await expect(f.definitions.get('skills_list').execute({}, f.exec)).rejects.toThrow('本轮未提供')
    expect(() => f.tools.update({ ...f.binding, worldId: 'other' })).toThrow('不能切换')
  })
  it('aborts stale in-flight bindings and never reveals private endpoint/token errors', async () => {
    const f = fixture()
    let finish!: (response: Response) => void
    f.fetchImpl.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    f.tools.update(f.binding)
    const pending = f.definitions.get('skills_read').execute({ skillId: 'a' }, f.exec)
    f.tools.update({ ...f.binding, token: 'b'.repeat(64) })
    expect(f.fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    finish(Response.json({ skillId: 'a', revision: 'v1', path: 'SKILL.md', content: 'LATE', totalChars: 4, resources: [] }))
    await expect(pending).rejects.toThrow('授权已失效')
    f.fetchImpl.mockRejectedValue(new Error(f.binding.endpoint + f.binding.token))
    await expect(f.definitions.get('skills_read').execute({ skillId: 'a' }, f.exec)).rejects.toThrow('授权已失效')
    f.fetchImpl.mockResolvedValue(Response.json({ error: { code: 'skill_document_not_text' } }, { status: 422 }))
    await expect(f.definitions.get('skills_read').execute({ skillId: 'a' }, f.exec)).rejects.toThrow('纯文本')
  })
  it('permits only live children created in the active binding generation, including nested children', async () => {
    const f = fixture()
    f.tools.update(f.binding)
    const child = { id: 'child', session: { id: 'child' } }
    const grandchild = { id: 'grandchild', session: { id: 'grandchild' } }
    const stranger = { id: 'stranger', session: { id: 'stranger', parentSession: 'session' } }
    for (const [agent, owner] of [[child, f.root], [grandchild, child], [stranger, undefined]] as const) {
      f.agents.set(agent.id, agent)
      if (owner) f.owners.set(agent.id, owner)
      f.listeners.get('agent/created')!({ agent })
    }
    for (const agent of [f.root, child, grandchild]) {
      expect(await f.definitions.get('skills_read').execute({ skillId: 'a' }, { ...f.exec, agent })).toMatchObject({ content: 'BODY' })
    }
    await expect(f.definitions.get('skills_read').execute({ skillId: 'a' }, { ...f.exec, agent: stranger })).rejects.toThrow('本轮未提供')
    // A continuable child cannot acquire a later turn's capability, even if
    // that child only makes its first tool call during the later turn.
    const late = { id: 'late', session: { id: 'late' } }
    f.agents.set(late.id, late); f.owners.set(late.id, f.root)
    f.listeners.get('agent/created')!({ agent: late })
    f.tools.update({ binding: null })
    f.tools.update({ ...f.binding, token: 'b'.repeat(64) })
    for (const agent of [child, grandchild, late]) {
      await expect(f.definitions.get('skills_read').execute({ skillId: 'a' }, { ...f.exec, agent })).rejects.toThrow('本轮未提供')
    }
    const staleDescendant = { id: 'stale-descendant', session: { id: 'stale-descendant' } }
    f.agents.set(staleDescendant.id, staleDescendant); f.owners.set(staleDescendant.id, late)
    f.listeners.get('agent/created')!({ agent: staleDescendant })
    await expect(f.definitions.get('skills_list').execute({}, { ...f.exec, agent: staleDescendant })).rejects.toThrow('本轮未提供')
    expect(await f.definitions.get('skills_list').execute({}, f.exec)).toMatchObject({ totalSkills: 1 })
  })
  it('keeps all content and resource names reachable below eager-pruner budget', async () => {
    const f = fixture()
    const body = '标题\n' + '\u0001\\"😀'.repeat(2_000)
    const resources = Array.from({ length: 200 }, (_, index) => `source/references/${index}-${'长'.repeat(180)}.md`)
    f.fetchImpl.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init!.body as string)
      const content = body.slice(request.offset, request.offset + request.limit)
      const nextOffset = request.offset + content.length
      const resourcePage = resources.slice(request.resourceOffset, request.resourceOffset + 8)
      const nextResourceOffset = request.resourceOffset + resourcePage.length
      return Response.json({ skillId: 'a', revision: 'v1', path: 'SKILL.md', content, totalChars: body.length,
        ...(nextOffset < body.length ? { nextOffset } : {}), resources: resourcePage, totalResources: resources.length,
        ...(nextResourceOffset < resources.length ? { nextResourceOffset } : {}),
      })
    })
    f.tools.update(f.binding)
    let offset = 0
    let resourceOffset = 0
    let reconstructed = ''
    const discovered: string[] = []
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await f.definitions.get('skills_read').execute({ skillId: 'a', offset, resourceOffset }, f.exec)
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(SKILL_TOOL_RESULT_MAX_CHARS)
      reconstructed += page.content
      discovered.push(...page.resources)
      if (page.nextOffset === undefined && page.nextResourceOffset === undefined) break
      offset = page.nextOffset ?? body.length
      resourceOffset = page.nextResourceOffset ?? resources.length
    }
    expect(reconstructed).toBe(body)
    expect(discovered).toEqual(resources)
  })
  it('paginates large discovery lists and bounds escaped summary previews', async () => {
    const f = fixture()
    const skills = Array.from({ length: 100 }, (_, index) => ({ id: `skill-${index}`, displayName: '技能', summary: '\u0001'.repeat(2000), revision: 'v1' }))
    f.tools.update({ ...f.binding, skills })
    const ids: string[] = []
    let offset = 0
    for (let index = 0; index < 100; index += 1) {
      const page = await f.definitions.get('skills_list').execute({ offset }, f.exec)
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(SKILL_TOOL_RESULT_MAX_CHARS)
      ids.push(...page.skills.map((skill: any) => skill.id))
      if (page.nextOffset === undefined) break
      offset = page.nextOffset
    }
    expect(ids).toEqual(skills.map((skill) => skill.id))
  })
  it('rejects non-loopback, alternate paths and responses outside its page budget', async () => {
    const f = fixture()
    for (const endpoint of ['https://remote.example/read', 'http://127.0.0.1:80/other', 'http://127.0.0.1:123/skill-documents/read?x=1']) {
      expect(() => f.tools.update({ ...f.binding, endpoint })).toThrow()
    }
    f.tools.update(f.binding)
    f.fetchImpl.mockResolvedValue(Response.json({ content: 'x'.repeat(513 * 1024) }))
    await expect(f.definitions.get('skills_read').execute({ skillId: 'a' }, f.exec)).rejects.toThrow('不可用')
  })
})
