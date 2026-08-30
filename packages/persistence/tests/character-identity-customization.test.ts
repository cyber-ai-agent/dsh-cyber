import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { EmployeeBlueprint } from '@dsh-cyber/contracts'

import { SqliteStore } from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('character identity customization', () => {
  it('persists character gender and voice profile across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-character-voice-'))
    const databasePath = join(root, 'dsh-cyber.sqlite')
    const store = await SqliteStore.open(databasePath)
    stores.push(store)
    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '我的世界', templateId: 'personal-world' })
    store.saveBlueprint({ schemaVersion: 1, id: 'voice.role', version: 1, worldTemplateId: 'personal-world', displayName: '阿洛', role: '工程师', summary: '语音档案测试角色', persona: '保持专业。', requestedSkills: [], requestedCapabilities: [], createdAt: '2026-08-30T00:00:00.000Z' })
    const character = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: 'voice.role', blueprintVersion: 1 })

    store.reviseEmployeeProfile({
      employeeId: character.id,
      gender: 'male',
      voiceProfile: { provider: 'kokoro', voiceId: 'kokoro:58', speed: 1.2, pitch: 1 },
      reason: '保存角色语音档案',
    })
    store.close()
    stores.pop()

    const reopened = await SqliteStore.open(databasePath)
    stores.push(reopened)
    expect(reopened.getEmployeeProfile(character.id)).toMatchObject({
      gender: 'male',
      voiceProfile: { provider: 'kokoro', voiceId: 'kokoro:58', speed: 1.2, pitch: 1 },
    })
  })

  it('updates the current character identity label while keeping the source blueprint immutable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-character-identity-'))
    const store = await SqliteStore.open(join(root, 'dsh-cyber.sqlite'))
    stores.push(store)

    const workspace = store.createWorkspace({ name: '本地实例' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '我的世界', templateId: 'personal-world' })
    const sourceBlueprint: EmployeeBlueprint = {
      schemaVersion: 1,
      id: 'legacy.secretary',
      version: 1,
      worldTemplateId: 'personal-world',
      displayName: '小周',
      role: '秘书',
      summary: '创建时使用的秘书模板。',
      persona: '你是一个细致的秘书。',
      requestedSkills: [],
      requestedCapabilities: [],
      createdAt: '2026-08-23T00:00:00.000Z',
    }
    store.saveBlueprint(sourceBlueprint)
    const character = store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: sourceBlueprint.id,
      blueprintVersion: sourceBlueprint.version,
    })

    store.reviseEmployeeProfile({
      employeeId: character.id,
      displayName: '团子',
      role: '陪伴小猫',
      background: '团子是一只长期陪伴用户生活的猫，在这个世界里有自己的经历和关系。',
      personalityTraits: ['傲娇', '敏感', '亲近'],
      appearance: { actorRigId: 'cat-companion' },
      reason: '用户重新定义当前角色身份',
    })

    const current = store.getEmployee(character.id)
    expect(current).toMatchObject({
      displayName: '团子',
      role: '陪伴小猫',
      blueprintId: 'legacy.secretary',
      blueprintVersion: 1,
    })
    expect(store.getBlueprint(sourceBlueprint.id, sourceBlueprint.version)).toEqual(sourceBlueprint)

    const events = store.listWorldDomainEvents(world.id)
    expect(events.find((event) => event.type === 'employee.profile.revised')?.payload).toMatchObject({
      employeeId: character.id,
      displayName: '团子',
      role: '陪伴小猫',
      identityChanged: true,
    })
  })
})
