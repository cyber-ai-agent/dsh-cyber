import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSkillDocuments, EmployeeInstance, EmployeeRevision, InstalledPackage, World, Workspace } from '@dsh-cyber/contracts'
import { parseSkillDocumentReadRequest, parseSkillDocumentReadResult } from '@dsh-cyber/contracts'
import { importSkillMarkdownPackage } from '../src/services/skill-markdown-import.js'
import { SkillCatalogService } from '../src/services/skill-catalog-service.js'
import { characterSkillDocuments } from '../src/services/character-skill-documents.js'
import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'
import { loadInstalledSkills } from '../src/installed-package-runtime.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('authorized on-demand skill documents', () => {
  it('puts only granted metadata in the persona, then reads body and reference through the actual turn provider', async () => {
    const f = await fixture()
    let handle: AgentSkillDocuments | undefined
    const runtime = new CharacterProfileRuntime({
      async runTurn(request) {
        handle = request.skillDocuments
        expect(handle?.skills.map((skill) => skill.id).sort()).toEqual([f.skillId, 'coding'].sort())
        expect(request.revision.persona).toContain('skills_read')
        expect(request.revision.persona).not.toContain('PRIVATE_BODY')
        expect(request.revision.persona).not.toContain('REFERENCE_ONLY')
        expect(request.revision.persona).not.toContain(f.registry.recipeForSkill('coding')!.instruction)
        const args = parseSkillDocumentReadRequest({ skillId: f.skillId, limit: 12 })
        const first = await handle!.read(args)
        expect(parseSkillDocumentReadResult(first, args, handle!.skills.find((skill) => skill.id === f.skillId)!.revision).content).toBe('PRIVATE_BODY')
        expect(first.nextOffset).toBe(12)
        const rest = await handle!.read({ skillId: f.skillId, offset: first.nextOffset })
        expect(first.content + rest.content).toContain('PRIVATE_BODY evidence first')
        expect(first.resources).toContain('source/references/check.md')
        expect((await handle!.read({ skillId: f.skillId, path: 'source/references/check.md' })).content).toBe('REFERENCE_ONLY')
        expect((await handle!.read({ skillId: 'coding' })).content).toBe(f.registry.recipeForSkill('coding')!.instruction)
        await expect(handle!.read({ skillId: 'testing' })).rejects.toThrow('未授权')
        return { finalResponse: '已依据工作方法读取证据。', eventCount: 0, agentSessionId: 'test' }
      }, async close() {},
    }, f.store, f.registry, undefined, f.service)
    await runtime.runTurn({ agent: f.agent, revision: f.revision, conversationId: 'conversation', history: [], observedThroughSequence: 0, prompt: '请按开发流程核验', workspacePath: f.root })
    await expect(handle!.read({ skillId: f.skillId })).rejects.toThrow('未授权')
  })

  it.each(['grant', 'character', 'world', 'installation', 'activation', 'moved'] as const)('rejects live %s revocation without a new turn', async (kind) => {
    const f = await fixture()
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    expect((await handle.documents.read({ skillId: f.skillId })).content).toContain('PRIVATE_BODY')
    if (kind === 'grant') f.revision.skillGrants = []
    if (kind === 'character') f.agent.status = 'archived'
    if (kind === 'world') f.world.status = 'archived'
    if (kind === 'installation') f.installed.status = 'disabled'
    if (kind === 'activation') f.active.value = false
    if (kind === 'moved') f.agent.worldId = 'another-world'
    await expect(handle.documents.read({ skillId: f.skillId })).rejects.toThrow()
  })

  it('does not return in-flight content after the grant was revoked or the turn ended', async () => {
    const f = await fixture()
    const read = f.service.readDocumentForWorld.bind(f.service)
    f.service.readDocumentForWorld = async (input) => {
      const result = await read(input)
      f.revision.skillGrants = []
      return result
    }
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    await expect(handle.documents.read({ skillId: f.skillId })).rejects.toThrow('撤销')
    handle.close()
    await expect(handle.documents.read({ skillId: f.skillId })).rejects.toThrow('未授权')
  })

  it('rechecks role state after the final asynchronous availability lookup', async () => {
    const f = await fixture()
    let calls = 0
    const handle = (await characterSkillDocuments({ store: f.store, agent: f.agent, grantedSkillIds: f.revision.skillGrants, availability: {
      isAvailable: () => true,
      documentsForWorld: async () => [{ id: f.skillId, displayName: '测试', summary: '测试', revision: 'one' }],
      availableSkillIds: async ({ skillIds }) => { if (++calls === 2) f.revision.skillGrants = []; return [...skillIds] },
      readDocumentForWorld: async () => ({ skillId: f.skillId, revision: 'one', path: 'SKILL.md', content: 'SECRET', totalChars: 6, resources: [] }),
    } }))!
    await expect(handle.documents.read({ skillId: f.skillId })).rejects.toThrow('撤销')
    expect(calls).toBe(2)
  })

  it('rejects world-scope revocation during the final catalog lookup', async () => {
    const f = await fixture()
    let skillIds = ['coding']
    let revoke = false
    const service = new SkillCatalogService({ store: f.store, registry: f.registry,
      scopeSettings: { get: (workspaceId, scope, scopeId) => ({ workspaceId, scope, scopeId, skillIds, updatedAt: '2026-10-08T00:00:00Z' }), save: () => { throw new Error('unused') }, clear: () => false },
      worldPackages: { listRuntimePackages: async () => { if (revoke) skillIds = []; return [] } },
    })
    const read = service.readDocumentForWorld.bind(service)
    service.readDocumentForWorld = async (input) => { const result = await read(input); revoke = true; return result }
    const handle = (await characterSkillDocuments({ store: f.store, agent: f.agent, grantedSkillIds: ['coding'], availability: service }))!
    await expect(handle.documents.read({ skillId: 'coding' })).rejects.toThrow('撤销')
    expect(skillIds).toEqual([])
  })

  it('rejects undeclared, traversal, binary, tampered and symlinked references', async () => {
    const f = await fixture()
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    for (const path of ['../secret.md', '/etc/passwd', 'source/%2e%2e/secret', 'skill.json', 'source/missing.md']) {
      await expect(handle.documents.read({ skillId: f.skillId, path })).rejects.toThrow()
    }
    await expect(handle.documents.read({ skillId: f.skillId, path: 'source/assets/binary.bin' })).rejects.toThrow()
    const reference = join(f.root, 'source/references/check.md')
    await writeFile(reference, 'TAMPERED')
    await expect(handle.documents.read({ skillId: f.skillId, path: 'source/references/check.md' })).rejects.toThrow('hash mismatch')
    await rm(reference)
    await symlink(join(f.root, 'source/SKILL.md'), reference)
    await expect(handle.documents.read({ skillId: f.skillId, path: 'source/references/check.md' })).rejects.toThrow('Symbolic')
  })

  it('pins discovery to its package revision and scopes metadata to a World', async () => {
    const f = await fixture()
    expect(await f.service.documentsForWorld({ workspaceId: 'other', worldId: f.world.id, skillIds: [f.skillId] })).toEqual([])
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    f.installed.version = '2.0.0'
    f.installed.manifest.version = '2.0.0'
    await expect(handle.documents.read({ skillId: f.skillId })).rejects.toThrow('版本')
  })

  it('redacts full values before pagination, with safe stable cursor lengths', async () => {
    const f = await fixture()
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants,
      redactText: (text) => text.replaceAll('PRIVATE_BODY', '${credential.example-long-reference}'),
    }))!
    let offset = 0
    let output = ''
    do {
      const args = parseSkillDocumentReadRequest({ skillId: f.skillId, offset, limit: 5 })
      const result = await handle.documents.read(args)
      parseSkillDocumentReadResult(result, args, handle.documents.skills.find((item) => item.id === f.skillId)!.revision)
      output += result.content
      if (result.nextOffset === undefined) break
      offset = result.nextOffset
    } while (true)
    expect(output).toBe('${credential.example-long-reference} evidence first\n')
    expect(output).not.toContain('PRIVATE')
  })

  it('keeps detail usable when companions are binary or too large for text loading', async () => {
    const f = await fixture([
      { path: 'references/large.txt', bytes: Buffer.alloc(640_000, 'x') },
      { path: 'references/utf16.txt', bytes: Buffer.from([255, 254, 65, 0]) },
    ])
    const detail = await f.service.detailWorkspace(f.agent.workspaceId, f.skillId)
    expect(detail.files.some((file) => file.path === 'source/SKILL.md')).toBe(true)
    expect(detail.files.some((file) => file.path === 'source/references/large.txt')).toBe(false)
    expect(detail.files.some((file) => file.path === 'source/references/utf16.txt')).toBe(false)
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    await expect(handle.documents.read({ skillId: f.skillId, path: 'source/references/large.txt' })).rejects.toThrow('skill_document_too_large')
    await expect(handle.documents.read({ skillId: f.skillId, path: 'source/references/utf16.txt' })).rejects.toThrow('skill_document_not_text')
  })

  it('rejects a native declaration whose document is absent from the package inventory', async () => {
    const f = await fixture()
    const manifest = JSON.parse(await readFile(join(f.root, 'skill.json'), 'utf8'))
    manifest.instructionFile = 'undeclared.md'
    const bytes = Buffer.from(JSON.stringify(manifest))
    await writeFile(join(f.root, 'skill.json'), bytes)
    f.installed.manifest.files.find((file) => file.path === 'skill.json')!.sha256 = createHash('sha256').update(bytes).digest('hex')
    await expect(loadInstalledSkills([f.installed])).rejects.toThrow('not declared')
  })

  it('pages long resource indexes without losing any declared path', async () => {
    const extras = Array.from({ length: 18 }, (_, index) => ({ path: `references/part-${index}.md`, bytes: Buffer.from('reference') }))
    const f = await fixture(extras)
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    const paths: string[] = []
    let resourceOffset = 0
    do {
      const args = parseSkillDocumentReadRequest({ skillId: f.skillId, resourceOffset })
      const result = await handle.documents.read(args)
      parseSkillDocumentReadResult(result, args, handle.documents.skills.find((item) => item.id === f.skillId)!.revision)
      expect(result.resources.length).toBeLessThanOrEqual(8)
      paths.push(...result.resources)
      if (result.nextResourceOffset === undefined) break
      resourceOffset = result.nextResourceOffset
    } while (true)
    expect(new Set(paths).size).toBe(20)
    expect(paths).toEqual(expect.arrayContaining(extras.map((file) => `source/${file.path}`)))
  })

  it('keeps Unicode characters intact at page boundaries', async () => {
    const f = await fixture([], '🙂a🙂b')
    const handle = (await characterSkillDocuments({ store: f.store, availability: f.service, agent: f.agent, grantedSkillIds: f.revision.skillGrants }))!
    const first = await handle.documents.read({ skillId: f.skillId, limit: 4 })
    expect(first.content).toBe('🙂a')
    expect(first.nextOffset).toBe(3)
    expect((await handle.documents.read({ skillId: f.skillId, offset: first.nextOffset })).content).toBe('🙂b')
    await expect(handle.documents.read({ skillId: f.skillId, offset: 1 })).rejects.toThrow('Unicode')
  })
})

async function fixture(extraFiles: Array<{ path: string; bytes: Buffer }> = [], body = 'PRIVATE_BODY evidence first\n') {
  const root = await mkdtemp(join(tmpdir(), 'skill-documents-')); roots.push(root)
  const result = importSkillMarkdownPackage([
    { path: 'SKILL.md', bytes: Buffer.from(`---\nname: engineering-pilot\ndescription: 验证开发过程\nlicense: MIT\n---\n${body}`) },
    { path: 'references/check.md', bytes: Buffer.from('REFERENCE_ONLY') },
    { path: 'assets/binary.bin', bytes: Buffer.from([0, 255, 128]) },
    ...extraFiles,
  ])
  for (const file of result.files) { const path = join(root, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes) }
  const stamp = '2026-10-08T00:00:00Z'
  const workspace: Workspace = { id: 'workspace', name: '工作区', status: 'active', createdAt: stamp, updatedAt: stamp }
  const world: World = { id: 'world', workspaceId: workspace.id, name: '世界', templateId: 'personal-world', status: 'active', createdAt: stamp, updatedAt: stamp }
  const agent: EmployeeInstance = { id: 'actor', workspaceId: workspace.id, worldId: world.id, blueprintId: 'butler', blueprintVersion: 1, displayName: '角色', role: '开发', status: 'available', currentRevision: 1, createdAt: stamp, updatedAt: stamp }
  const skillId = result.manifest.entrypoints![0]!.id
  const revision: EmployeeRevision = { employeeId: agent.id, revision: 1, persona: '如实提供证据', skillGrants: [skillId, 'coding'], capabilityGrants: [], modelPolicy: {}, reason: 'test', createdAt: stamp }
  const installed: InstalledPackage = { workspaceId: workspace.id, packageId: result.manifest.id, version: '1.0.0', kind: 'skill', status: 'active', installedPath: root, capabilities: result.manifest.capabilities, manifest: result.manifest, installedAt: stamp, updatedAt: stamp }
  const active = { value: true }
  const store = {
    getWorkspace: (id: string) => id === workspace.id ? workspace : undefined,
    getWorld: (id: string) => id === world.id ? world : undefined,
    getEmployee: (id: string) => id === agent.id ? agent : undefined,
    getEmployeeRevision: () => revision,
    getEmployeeProfile: () => undefined,
    listInstalledPackages: () => [installed],
  }
  const registry = createBuiltinSkillRegistry()
  const service = new SkillCatalogService({ store, registry, worldPackages: { listRuntimePackages: async () => active.value ? [installed] : [] } })
  return { root, store, registry, service, agent, world, revision, installed, active, skillId }
}
