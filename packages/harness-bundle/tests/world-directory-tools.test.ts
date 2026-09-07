import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WorldDirectoryTools } from '../src/world-directory-tools.js'

function fixture() {
  const definitions = new Map<string, any>()
  const ctx = {
    tools: { register: (tool: any) => { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } },
    effect: (callback: () => unknown) => callback(),
  } as unknown as Context
  const directory = new WorldDirectoryTools(ctx)
  const snapshot = { actorId: 'a', worldId: 'world', workspaceId: 'workspace', revision: 'v1', availabilityKnown: true,
    members: [{ characterId: 'a', displayName: '本地角色', role: '', characterRevision: 1, grantedSkillIds: [], availableSkillIds: [], persona: 'DO-NOT-SHARE', privateMessages: 'PRIVATE-CHAT' }] }
  return { directory, definitions, snapshot }
}
describe('read-only worker directory binding', () => {
  it('registers usable list/search/get and rejects arbitrary world selection', async () => {
    const { directory, definitions, snapshot } = fixture()
    directory.update(snapshot)
    expect(definitions.size).toBe(3)
    const list = await definitions.get('world_directory_list').execute({ worldId: 'outside' })
    expect(list.items).toHaveLength(1)
    expect(JSON.stringify(list)).not.toMatch(/DO-NOT-SHARE|PRIVATE-CHAT/)
    expect(await definitions.get('world_directory_get').execute({ characterId: 'outside' })).toMatchObject({ member: null })
    expect(await definitions.get('world_directory_search').execute({ query: '本地' })).toMatchObject({ matchedMembers: 1 })
  })
  it('updates one worker atomically and refuses identity/world switching or duplicate IDs', () => {
    const { directory, definitions, snapshot } = fixture()
    directory.update(snapshot)
    expect(() => directory.update({ ...snapshot, worldId: 'outside' })).toThrow('不能切换')
    expect(() => directory.update({ ...snapshot, members: [snapshot.members[0], snapshot.members[0]] })).toThrow('重复')
    expect(() => directory.update({ ...snapshot, actorId: 'missing' })).toThrow('必须在')
    expect(directory.update({ ...snapshot, revision: 'v2' })).toMatchObject({ revision: 'v2' })
    expect(definitions.size).toBe(3)
  })
})
