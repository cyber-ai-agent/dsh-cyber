import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '@dsh-cyber/persistence'
import {
  ContextInputTooLargeError, estimateTextTokens, getWorldDirectoryMember, planContextBudget, queryWorldDirectory,
  type AgentTurnRequest, type EmployeeBlueprint, type WorldDirectorySnapshot,
} from '@dsh-cyber/contracts'
import { WorldCharacterDirectoryService, composeWorldDirectoryLayer } from '../src/services/world-character-directory-service.js'
import { CharacterProfileRuntime } from '../src/services/character-profile-runtime.js'

const resources: Array<{ store: SqliteStore; root: string }> = []
afterEach(async () => {
  for (const { store, root } of resources.splice(0)) { store.close(); await rm(root, { recursive: true, force: true }) }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cyber-directory-'))
  const store = await SqliteStore.open(join(root, 'db.sqlite'))
  resources.push({ store, root })
  const workspace = store.createWorkspace({ name: '测试工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '办公室', templateId: 'personal-world' })
  const other = store.createWorld({ workspaceId: workspace.id, name: '别的世界', templateId: 'personal-world' })
  const blueprint: EmployeeBlueprint = { schemaVersion: 1, id: 'directory.worker', version: 1, worldTemplateId: 'personal-world', displayName: '模板名', role: '旧模板职位', summary: 'NOT-A-WORLD-MEMBER', persona: 'PRIVATE-PERSONA', requestedSkills: [], requestedCapabilities: [], createdAt: '2026-09-07T00:00:00Z' }
  store.saveBlueprint(blueprint)
  const recruit = (name: string, role: string, worldId = world.id) => store.recruitEmployee({ workspaceId: workspace.id, worldId, blueprintId: blueprint.id, blueprintVersion: 1, displayName: name, role, skillGrants: ['research', 'missing'] })
  const self = recruit('林舟', '开发')
  const colleague = recruit('小夏', '视觉设计')
  recruit('外部角色', '外部世界资料', other.id)
  const availability = { isAvailable: vi.fn(() => false), availableSkillIds: vi.fn(() => ['research', 'ungranted']) }
  return { root, store, workspace, world, other, self, colleague, recruit, availability, directory: new WorldCharacterDirectoryService(store, availability) }
}

describe('world member directory as live public facts', () => {
  it('knows every local member without exposing private personas or other worlds', async () => {
    const f = await fixture()
    const snapshot = await f.directory.snapshot(f.world.id, f.self.id)
    expect(snapshot.members.map((member) => member.displayName).sort()).toEqual(['小夏', '林舟'].sort())
    expect(snapshot.members.every((member) => member.availableSkillIds.join() === 'research')).toBe(true)
    const value = JSON.stringify(snapshot)
    for (const hidden of ['PRIVATE-PERSONA', 'NOT-A-WORLD-MEMBER', '外部角色', '旧模板职位']) expect(value).not.toContain(hidden)
    expect(f.availability.availableSkillIds).toHaveBeenCalledOnce()
    expect(f.availability.isAvailable).not.toHaveBeenCalled()
    await expect(f.directory.snapshot(f.other.id, f.self.id)).rejects.toThrow('不属于')
  })

  it('keeps public membership if an optional colleague capability probe fails', async () => {
    const f = await fixture()
    const service = new WorldCharacterDirectoryService(f.store, { isAvailable: async () => { throw new Error('integration unavailable') } })
    const snapshot = await service.snapshot(f.world.id, f.self.id)
    expect(snapshot.members).toHaveLength(2)
    expect(snapshot.availabilityKnown).toBe(false)
  })
  it('reflects rename, public role edits, recruitment and archival without restart', async () => {
    const f = await fixture()
    const first = await f.directory.snapshot(f.world.id, f.self.id)
    f.store.reviseEmployeeProfile({ employeeId: f.colleague.id, displayName: '安宁', role: '产品设计', reason: '更新' })
    const second = await f.directory.snapshot(f.world.id, f.self.id)
    expect(second.revision).not.toBe(first.revision)
    expect(getWorldDirectoryMember(second, f.colleague.id)).toMatchObject({ displayName: '安宁', role: '产品设计' })
    f.recruit('研究同事', '研究')
    expect((await f.directory.snapshot(f.world.id, f.self.id)).members).toHaveLength(3)
    f.store.archiveEmployee(f.colleague.id)
    const current = await f.directory.snapshot(f.world.id, f.self.id)
    expect(current.members).toHaveLength(2)
    expect(getWorldDirectoryMember(current, f.colleague.id)).toBeUndefined()
    expect(() => queryWorldDirectory(current, { expectedRevision: first.revision })).toThrow('已更新')
  })
  it('does not churn the prefix hash on ordinary working status changes', async () => {
    const f = await fixture()
    const first = await f.directory.snapshot(f.world.id, f.self.id)
    const session = f.store.createSession({ workspaceId: f.workspace.id, worldId: f.world.id, kind: 'direct', title: '工作中', participants: [{ kind: 'employee', participantId: f.colleague.id }] })
    const turn = f.store.createWorkTurn({ workspaceId: f.workspace.id, worldId: f.world.id, sessionId: session.id, interactionKind: 'chat' })
    f.store.startWorkTurn(turn.id)
    const run = f.store.createAgentRun({ workspaceId: f.workspace.id, worldId: f.world.id, sessionId: session.id, turnId: turn.id, employeeId: f.colleague.id, ordinal: 1 })
    f.store.startAgentRun(run.id)
    expect((await f.directory.snapshot(f.world.id, f.self.id)).revision).toBe(first.revision)
  })
  it('keeps duplicate display names distinct and supports full bounded pagination', async () => {
    const f = await fixture()
    f.recruit('小夏', '研究')
    const snapshot = await f.directory.snapshot(f.world.id, f.self.id)
    const duplicates = queryWorldDirectory(snapshot, { query: '小夏' })
    expect(duplicates.items).toHaveLength(2)
    expect(new Set(duplicates.items.map((member) => member.characterId)).size).toBe(2)
    const ids: string[] = []
    for (let offset = 0; offset < snapshot.members.length; offset += 1) ids.push(...queryWorldDirectory(snapshot, { offset, limit: 1, expectedRevision: snapshot.revision }).items.map((member) => member.characterId))
    expect(ids).toEqual(snapshot.members.map((member) => member.characterId))
    expect(() => queryWorldDirectory(snapshot, { limit: -1 })).toThrow()
    expect(() => queryWorldDirectory(snapshot, { query: 'x'.repeat(257) })).toThrow()
  })
  it('names unverified availability explicitly instead of presenting missing probes as zero skills', async () => {
    const f = await fixture()
    const snapshot = await new WorldCharacterDirectoryService(f.store).snapshot(f.world.id, f.self.id)
    expect(queryWorldDirectory(snapshot).availabilityKnown).toBe(false)
    expect(snapshot.members[0]!.grantedSkillIds).not.toHaveLength(0)
    expect(snapshot.members[0]!.availableSkillIds).toEqual([])
  })
  it('bounds the inline roster while keeping every large-world member queryable', async () => {
    const f = await fixture()
    const snapshot: WorldDirectorySnapshot = await f.directory.snapshot(f.world.id, f.self.id)
    snapshot.members.push(...Array.from({ length: 500 }, (_, n) => ({ characterId: `id-${n}`, displayName: `成员${n}`, role: '公开职责', characterRevision: 1, grantedSkillIds: [], availableSkillIds: [] })))
    const layer = composeWorldDirectoryLayer(snapshot)
    expect(estimateTextTokens(layer.text)).toBeLessThanOrEqual(1_600)
    expect(layer.text).toContain('502')
    expect(layer.text).toContain('仅列出')
    expect(layer.text).toContain('world_directory_search')
    expect(queryWorldDirectory(snapshot, { query: '成员499' }).items[0]?.characterId).toBe('id-499')
    expect(layer.sourceRefs.filter((ref) => ref.kind === 'employee')).toHaveLength((layer.text.match(/"characterId":/g) ?? []).length)
  })
  it.each(['direct', 'group', 'task'] as const)('injects the same real membership through the unified %s runtime', async (kind) => {
    const f = await fixture()
    const requests: AgentTurnRequest[] = []
    const inner = { runTurn: async (request: AgentTurnRequest) => { requests.push(request); return { agentSessionId: 'session', finalResponse: '知道了', eventCount: 0 } }, close: async () => {} }
    const runtime = new CharacterProfileRuntime(inner, f.store, undefined, undefined, f.availability)
    const session = f.store.createSession({ workspaceId: f.workspace.id, worldId: f.world.id, kind, title: '名册测试', participants: [{ kind: 'employee', participantId: f.self.id }] })
    const request = { agent: f.self, revision: f.store.getEmployeeRevision(f.self.id, f.self.currentRevision)!, conversationId: session.id, history: [], observedThroughSequence: 0, prompt: '谁负责视觉设计？', workspacePath: f.root }
    await runtime.runTurn(request)
    const before = requests[0]!
    expect(before.revision.persona).toContain('小夏')
    expect(before.worldDirectory?.members).toHaveLength(2)
    expect(before.contextSourceRefs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'employee', id: f.colleague.id })]))
    f.store.reviseEmployeeProfile({ employeeId: f.colleague.id, displayName: '新名字', reason: '更新' })
    await runtime.runTurn(request)
    expect(requests[1]!.revision.persona).toContain('新名字')
    expect(requests[1]!.revision.persona).not.toContain('小夏')
    expect(requests[1]!.promptCache?.stablePrefixHash).not.toBe(before.promptCache?.stablePrefixHash)
  })
  it('counts roster tokens before dispatch instead of quietly exceeding the model budget', async () => {
    const f = await fixture()
    const inner = { runTurn: vi.fn(), close: async () => {} }
    const runtime = new CharacterProfileRuntime(inner, f.store)
    const session = f.store.createSession({ workspaceId: f.workspace.id, worldId: f.world.id, kind: 'direct', title: '预算', participants: [{ kind: 'employee', participantId: f.self.id }] })
    const budget = { ...planContextBudget({ contextWindow: 4096, maxOutputTokens: 512 }), fixedTokens: 0, inputBudgetTokens: 10 }
    await expect(runtime.runTurn({ agent: f.self, revision: f.store.getEmployeeRevision(f.self.id, 1)!, conversationId: session.id, history: [], observedThroughSequence: 0, prompt: '你好', workspacePath: f.root, contextBudget: budget })).rejects.toBeInstanceOf(ContextInputTooLargeError)
    expect(inner.runTurn).not.toHaveBeenCalled()
  })
})
