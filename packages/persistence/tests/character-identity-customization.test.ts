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
