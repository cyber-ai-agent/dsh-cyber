import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { RECOMMENDED_ADMIN_PERMISSIONS } from '@dsh-cyber/contracts/world-authority'
import { SqliteStore } from '@dsh-cyber/persistence'

import {
  WorldAuthorityPromotionRequiredError,
  WorldCharacterAuthorityService,
} from '../src/services/world-character-authority-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // Already closed.
    }
  }
})

const OWNER = { kind: 'owner', id: 'local-user' } as const

function blueprint(id: string, displayName: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'personal-world',
    displayName,
    role: '成员',
    summary: '测试角色',
    persona: `你是${displayName}。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-25T00:00:00.000Z',
  }
}

/**
 * Always seeds a second administrator.
 *
 * Without one, the last-administrator invariant throws before the code under
 * test runs, and an authority test passes for entirely the wrong reason.
 */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-authority-patch-'))
  const store = await SqliteStore.open(join(root, 'data', 'dsh-cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '工作区' })
  const created = store.createWorld({ workspaceId: workspace.id, name: '世界', templateId: 'personal-world' })
  const recruit = (id: string, displayName: string) => {
    store.saveBlueprint(blueprint(id, displayName))
    return store.recruitEmployee({
      workspaceId: workspace.id,
      worldId: created.id,
      blueprintId: id,
      blueprintVersion: 1,
    })
  }
  const laowang = recruit('laowang', '老王')
  const keeper = recruit('keeper', '管家')
  const authority = new WorldCharacterAuthorityService(store)
  authority.updateAuthority({
    worldId: created.id,
    targetEmployeeId: keeper.id,
    actor: OWNER,
    role: 'administrator',
    permissionGrants: [...RECOMMENDED_ADMIN_PERMISSIONS],
    reason: 'seed-second-administrator',
  })
  return { store, world: created, authority, laowang, keeper }
}

describe('world authority patch semantics', () => {
  it('grants without touching the role or the grants nobody mentioned', async () => {
    const { world: target, authority, laowang } = await world()
    authority.updateAuthority({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      role: 'administrator',
      permissionGrants: ['world.files.read', 'world.trace.read', 'world.permissions.read'],
      reason: 'seed',
    })

    const after = authority.grantPermissions({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      reason: '给老王世界设置权限',
      permissions: ['world.settings.write'],
    })

    // The old whole-object replacement demoted the target to member and left
    // permissionGrants empty — a permission edit said nothing about the role.
    expect(after.role).toBe('administrator')
    expect(after.permissionGrants).toEqual(expect.arrayContaining([
      'world.files.read',
      'world.trace.read',
      'world.settings.write',
    ]))
  })

  it('revokes only what was named', async () => {
    const { world: target, authority, laowang } = await world()
    authority.updateAuthority({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      role: 'administrator',
      permissionGrants: ['world.files.read', 'world.files.write', 'world.settings.write', 'world.permissions.read'],
      reason: 'seed',
    })

    const after = authority.revokePermissions({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      reason: '取消老王文件写入权限',
      permissions: ['world.files.write'],
    })

    expect(after.role).toBe('administrator')
    expect(after.permissionGrants).not.toContain('world.files.write')
    expect(after.permissionGrants).toEqual(expect.arrayContaining([
      'world.files.read',
      'world.settings.write',
      'world.permissions.read',
    ]))
  })

  it('applies the full recommended set when promoting, whatever the member already held', async () => {
    const { world: target, authority, laowang } = await world()
    authority.updateAuthority({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      role: 'member',
      permissionGrants: ['world.files.read'],
      reason: 'seed',
    })

    const after = authority.promote({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      reason: '把老王设成管理员',
      permissions: [],
    })

    expect(after.role).toBe('administrator')
    // A promotion that carried forward only files.read produced an
    // administrator who could not administrate.
    for (const permission of RECOMMENDED_ADMIN_PERMISSIONS) {
      expect(after.permissionGrants, permission).toContain(permission)
    }
    expect(after.permissionGrants).toContain('world.files.read')
  })

  it("keeps a member's read grants when demoting", async () => {
    const { world: target, authority, laowang } = await world()
    authority.updateAuthority({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      role: 'administrator',
      permissionGrants: ['world.files.read', 'world.trace.read', 'world.permissions.manage'],
      reason: 'seed',
    })

    const after = authority.demote({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      reason: '取消老王的管理员身份',
      permissions: [],
    })

    expect(after.role).toBe('member')
    expect(after.permissionGrants).toContain('world.files.read')
    expect(after.permissionGrants).toContain('world.trace.read')
    // Demotion is the one operation whose purpose is to drop management rights.
    expect(after.permissionGrants).not.toContain('world.permissions.manage')
  })

  it('refuses a management permission for a member instead of stripping it silently', async () => {
    const { store, world: target, authority, laowang } = await world()
    const before = authority.get(target.id, laowang.id)
    const changesBefore = store.listWorldAuthorityChanges(target.id).length

    expect(() => authority.updateAuthority({
      worldId: target.id,
      targetEmployeeId: laowang.id,
      actor: OWNER,
      role: 'member',
      permissionGrants: ['world.files.read', 'world.characters.manage'],
      reason: '给老王角色管理权限',
    })).toThrow(WorldAuthorityPromotionRequiredError)

    // No partial write, and — the part the audit ledger used to hide — no
    // record claiming a change happened. The rejection has to be visible as a
    // rejection, not as a smaller grant than the user asked for.
    expect(authority.get(target.id, laowang.id)).toEqual(before)
    expect(store.listWorldAuthorityChanges(target.id)).toHaveLength(changesBefore)
  })

  it('names the permissions it refused so the caller can offer promotion', async () => {
    const { world: target, authority, laowang } = await world()
    try {
      authority.updateAuthority({
        worldId: target.id,
        targetEmployeeId: laowang.id,
        actor: OWNER,
        role: 'member',
        permissionGrants: ['world.characters.manage', 'world.permissions.manage'],
        reason: 'test',
      })
      expect.unreachable('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(WorldAuthorityPromotionRequiredError)
      const refused = error as WorldAuthorityPromotionRequiredError
      expect(refused.code).toBe('requires_administrator_promotion')
      expect([...refused.permissions].sort())
        .toEqual(['world.characters.manage', 'world.permissions.manage'])
    }
  })
})

describe('world permission decision audit', () => {
  it('survives a retention sweep that prunes the turn it belonged to', async () => {
    const { store, world: target, laowang } = await world()
    const session = store.createSession({
      workspaceId: target.workspaceId,
      worldId: target.id,
      kind: 'direct',
      title: '私聊',
      participants: [{ participantId: 'owner', kind: 'owner' }],
    })
    const turn = store.createWorkTurn({
      workspaceId: target.workspaceId,
      worldId: target.id,
      sessionId: session.id,
      interactionKind: 'chat',
    })
    store.startWorkTurn(turn.id)
    const action = store.reserveSkillAction({
      id: 'action-audit-1',
      worldId: target.id,
      characterId: laowang.id,
      skillId: 'builtin.world.settings.update',
      adapterId: 'builtin.world-management',
      action: 'world.settings.update',
      target: `world:${target.id}`,
      label: '修改世界设置',
      risk: 'write-local',
      authorization: 'explicit-user-request',
      parameters: {},
      workTurnId: turn.id,
      status: 'waiting-for-approval',
      detail: '等待授权',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never, 0)
    void action
    const request = store.createWorldPermissionRequest({
      workspaceId: target.workspaceId,
      worldId: target.id,
      employeeId: laowang.id,
      workTurnId: turn.id,
      skillActionId: 'action-audit-1',
      permission: 'world.settings.write',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })
    store.decideWorldPermissionRequest(
      request.id,
      { decisionScope: 'once', decidedBy: 'local-user' },
      new Date().toISOString(),
    )
    store.completeWorkTurn(turn.id)

    // Retention sweeps settled telemetry. It must not sweep the record of who
    // allowed a real-world action: work_turn_id used to be NOT NULL with
    // ON DELETE CASCADE, so pruning the turn deleted the decision with it.
    const pruned = store.pruneHistory({ before: new Date(Date.now() + 60_000).toISOString() })
    expect(pruned.workTurns).toBeGreaterThan(0)

    const survivor = store.getWorldPermissionRequest(request.id)
    expect(survivor, '权限决策不得随回合被清理').toBeDefined()
    expect(survivor!.status).toBe('approved')
    expect(survivor!.decisionScope).toBe('once')
    expect(survivor!.decidedBy).toBe('local-user')
    expect(survivor!.skillActionId).toBe('action-audit-1')
  })
})
