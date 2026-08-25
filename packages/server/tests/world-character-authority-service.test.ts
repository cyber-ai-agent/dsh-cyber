import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RECOMMENDED_ADMIN_PERMISSIONS, type EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { ServiceError } from '../src/services/service-error.js'
import { WorldCharacterAuthorityService } from '../src/services/world-character-authority-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function fixture(): Promise<{
  store: SqliteStore
  world: ReturnType<SqliteStore['createWorld']>
  secondWorld: ReturnType<SqliteStore['createWorld']>
  first: ReturnType<SqliteStore['recruitEmployee']>
  second: ReturnType<SqliteStore['recruitEmployee']>
  otherWorldEmployee: ReturnType<SqliteStore['recruitEmployee']>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-authority-service-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: 'Authority test' })
  const world = store.createWorld({ workspaceId: workspace.id, name: 'Primary', templateId: 'cyber-company' })
  const secondWorld = store.createWorld({ workspaceId: workspace.id, name: 'Secondary', templateId: 'cyber-company' })
  const blueprint: EmployeeBlueprint = {
    schemaVersion: 1,
    id: 'authority-character',
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: '角色',
    role: '成员',
    summary: '权限测试角色',
    persona: '保持边界。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-25T00:00:00.000Z',
  }
  store.saveBlueprint(blueprint)
  const first = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, displayName: '管理员甲' })
  const second = store.recruitEmployee({ workspaceId: workspace.id, worldId: world.id, blueprintId: blueprint.id, blueprintVersion: 1, displayName: '成员乙' })
  const otherWorldEmployee = store.recruitEmployee({ workspaceId: workspace.id, worldId: secondWorld.id, blueprintId: blueprint.id, blueprintVersion: 1, displayName: '别界角色' })
  return { store, world, secondWorld, first, second, otherWorldEmployee }
}

describe('WorldCharacterAuthorityService', () => {
  it('creates a useful first administrator and supports multiple administrators', async () => {
    const { store, world, first, second } = await fixture()
    const service = new WorldCharacterAuthorityService(store)

    expect(service.get(world.id, first.id)).toMatchObject({
      role: 'administrator',
      permissionGrants: [...RECOMMENDED_ADMIN_PERMISSIONS],
    })
    expect(service.get(world.id, second.id)).toMatchObject({
      role: 'member',
      permissionGrants: ['world.files.read'],
    })

    const secondAuthority = service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: second.id,
      actor: { kind: 'owner', id: 'local-user' },
      role: 'administrator',
      permissionGrants: ['world.settings.read', 'world.settings.write', 'world.permissions.read'],
      reason: '委托世界设置维护',
    })
    expect(secondAuthority.role).toBe('administrator')
    expect(service.list(world.id).filter((item) => item.role === 'administrator')).toHaveLength(2)
    expect(store.getWorld(world.id)?.administratorEmployeeId).toBe(first.id)
    expect(store.listWorldAuthorityChanges(world.id)).toHaveLength(1)
    expect(store.listWorldDomainEvents(world.id).filter((event) => event.type === 'world.character.authority.changed')).toHaveLength(1)
  })

  it('enforces employee delegation, self-escalation and world isolation', async () => {
    const { store, world, secondWorld, first, second, otherWorldEmployee } = await fixture()
    const service = new WorldCharacterAuthorityService(store)
    const restrictedAdmin = [
      'world.files.read',
      'world.files.write',
      'world.settings.read',
      'world.settings.write',
      'world.characters.read',
      'world.characters.manage',
      'world.permissions.read',
      'world.permissions.manage',
    ] as const
    service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: first.id,
      actor: { kind: 'owner', id: 'local-user' },
      role: 'administrator',
      permissionGrants: [...restrictedAdmin],
      reason: '收窄委托范围',
    })

    expect(() => service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: second.id,
      actor: { kind: 'employee', id: first.id },
      role: 'administrator',
      permissionGrants: ['world.settings.write'],
      reason: '委托设置权限',
    })).not.toThrow()

    expect(() => service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: second.id,
      actor: { kind: 'employee', id: first.id },
      role: 'administrator',
      permissionGrants: ['world.packages.manage'],
      reason: '越权委托',
    })).toThrowError(expect.objectContaining({ code: 'authority_delegation_exceeds_grant' }))

    expect(() => service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: first.id,
      actor: { kind: 'employee', id: first.id },
      role: 'administrator',
      permissionGrants: [...restrictedAdmin],
      reason: '自我提权',
    })).toThrowError(expect.objectContaining({ code: 'authority_self_escalation' }))

    expect(() => service.updateAuthority({
      worldId: secondWorld.id,
      targetEmployeeId: otherWorldEmployee.id,
      actor: { kind: 'employee', id: first.id },
      role: 'administrator',
      permissionGrants: ['world.settings.write'],
      reason: '跨世界',
    })).toThrowError(expect.objectContaining({ code: 'cross_world_authority' }))
  })

  it('keeps one active administrator and leaves the audit ledger outside prune', async () => {
    const { store, world, first, second } = await fixture()
    const service = new WorldCharacterAuthorityService(store)
    service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: second.id,
      actor: { kind: 'owner', id: 'local-user' },
      role: 'administrator',
      permissionGrants: [...RECOMMENDED_ADMIN_PERMISSIONS],
      reason: '增加管理员',
    })
    service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: first.id,
      actor: { kind: 'owner', id: 'local-user' },
      role: 'member',
      permissionGrants: ['world.files.read'],
      reason: '转为成员',
    })
    expect(() => service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: second.id,
      actor: { kind: 'owner', id: 'local-user' },
      role: 'member',
      permissionGrants: [],
      reason: '移除最后管理员',
    })).toThrowError(expect.objectContaining({ code: 'last_world_administrator' }))
    expect(() => service.archiveEmployee(world.id, second.id)).toThrowError(expect.objectContaining({ code: 'last_world_administrator' }))

    const before = store.listWorldAuthorityChanges(world.id).length
    expect(store.listWorldDomainEvents(world.id).some((event) => event.type === 'world.character.authority.changed')).toBe(true)
    store.pruneHistory({ before: '2999-01-01T00:00:00.000Z' })
    expect(store.listWorldAuthorityChanges(world.id)).toHaveLength(before)
  })

  it('reports missing permissions without treating the role as blanket access', async () => {
    const { store, world, second } = await fixture()
    const service = new WorldCharacterAuthorityService(store)
    expect(service.hasPermission(world.id, second.id, 'world.settings.write')).toBe(false)
    expect(() => service.assertPermission(world.id, second.id, 'world.settings.write')).toThrowError(ServiceError)
  })

  it('rolls back authority, audit and event together and rejects stale concurrent writes', async () => {
    const { store, world, first, second } = await fixture()
    const service = new WorldCharacterAuthorityService(store)
    const before = service.get(world.id, first.id)!
    const auditCount = store.listWorldAuthorityChanges(world.id).length
    const eventCount = store.listWorldDomainEvents(world.id).length

    expect(() => store.commitWorldAuthorityChange({
      expectedAuthority: before,
      authority: {
        ...before,
        permissionGrants: ['world.files.read'],
        updatedAt: '2026-08-25T00:00:01.000Z',
      },
      audit: {
        worldId: world.id,
        employeeId: first.id,
        actorKind: 'owner',
        actorId: 'local-user',
        previousRole: before.role,
        nextRole: 'administrator',
        addedPermissions: [],
        removedPermissions: ['world.conversations.read-metadata'],
        reason: 'atomic rollback probe',
      },
      event: {
        workspaceId: store.getWorld(world.id)!.workspaceId,
        worldId: world.id,
        actorId: 'local-user',
        actorKind: 'owner',
        payload: { apiKey: 'must-not-persist' },
      },
    })).toThrow(/Secret-like field/)
    expect(service.get(world.id, first.id)).toEqual(before)
    expect(store.listWorldAuthorityChanges(world.id)).toHaveLength(auditCount)
    expect(store.listWorldDomainEvents(world.id)).toHaveLength(eventCount)

    const stale = service.get(world.id, second.id)!
    const committed = service.updateAuthority({
      worldId: world.id,
      targetEmployeeId: second.id,
      actor: { kind: 'owner', id: 'local-user' },
      role: 'administrator',
      permissionGrants: ['world.settings.read'],
      reason: 'advance concurrent revision',
    })
    expect(() => store.commitWorldAuthorityChange({
      expectedAuthority: stale,
      authority: {
        ...stale,
        role: 'administrator',
        permissionGrants: ['world.settings.write'],
        updatedAt: '2026-08-25T00:00:02.000Z',
      },
      audit: {
        worldId: world.id,
        employeeId: second.id,
        actorKind: 'owner',
        actorId: 'local-user',
        previousRole: stale.role,
        nextRole: 'administrator',
        addedPermissions: ['world.settings.write'],
        removedPermissions: [],
        reason: 'stale concurrent revision',
      },
      event: {
        workspaceId: store.getWorld(world.id)!.workspaceId,
        worldId: world.id,
        actorId: 'local-user',
        actorKind: 'owner',
        payload: { employeeId: second.id },
      },
    })).toThrow('changed concurrently')
    expect(service.get(world.id, second.id)).toEqual(committed)
  })
})
