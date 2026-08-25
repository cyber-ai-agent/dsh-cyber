import { describe, expect, it } from 'vitest'

import { WorldManagementIntentParser } from '../src/services/world-management-intent-parser.js'

const parser = new WorldManagementIntentParser()
const context = {
  worldId: 'world-1',
  characters: [
    { id: 'employee-old-wang', displayName: '老王' },
    { id: 'employee-xiao-wang', displayName: '小王' },
  ],
}

describe('WorldManagementIntentParser', () => {
  it('turns the safe administrator question into a read-only authority query', () => {
    expect(parser.parse('老王是不是管理员？', context)).toEqual([expect.objectContaining({
      kind: 'read-authority',
      action: 'world.authority.read',
      requiredWorldPermission: 'world.permissions.read',
      parameters: { employeeId: 'employee-old-wang' },
    })])
  })

  it('does not mutate on negation, ordinary questions, or transformed/external text', () => {
    expect(parser.parse('不要把老王设成管理员', context)).toEqual([])
    expect(parser.parse('老王是不是管理员？以后把他设成管理员', context)).toEqual([])
    expect(parser.parse('把老王设成管理员', context, 'external')).toEqual([])
  })

  it('promotes and names the extra permissions in one proposal', () => {
    const [proposal] = parser.parse('把老王也设置成管理员，给他世界设置、角色管理和文件读写权限', context)
    expect(proposal).toMatchObject({ kind: 'authority-update', action: 'world.authority.update' })
    // The proposal states the operation, not a replacement role. A promotion
    // seeds the recommended administrator set in the adapter and then adds the
    // permissions the user named — the old payload replaced the whole grant
    // list with just these four, producing an administrator with no
    // world.permissions.read and no world.files.read of their own.
    expect(proposal?.parameters).toMatchObject({
      operation: 'promote',
      permissionGrants: [
        'world.settings.write',
        'world.characters.manage',
        'world.files.read',
        'world.files.write',
      ],
    })
    expect(proposal?.parameters.role).toBeUndefined()
  })

  it('never invents a role when the user only edits permissions', () => {
    // "给老王世界设置权限" used to emit role: 'member', which demoted an
    // administrator and erased every grant the sentence did not mention.
    const [grant] = parser.parse('给老王世界设置权限', context)
    expect(grant?.parameters).toMatchObject({ operation: 'grant', permissionGrants: ['world.settings.write'] })
    expect(grant?.parameters.role).toBeUndefined()

    const [revoke] = parser.parse('取消老王文件写入权限', context)
    expect(revoke?.parameters).toMatchObject({ operation: 'revoke', removePermissions: ['world.files.write'] })
    expect(revoke?.parameters.role).toBeUndefined()
    expect(revoke?.parameters.permissionGrants).toEqual([])
  })

  it('asks which character it meant instead of guessing or going silent', () => {
    // Returning [] told the user nothing happened, by way of a model that was
    // never told anything happened. A clarification names the candidates.
    const [proposal] = parser.parse('把王设置成管理员', {
      worldId: 'world-1',
      characters: [{ id: 'a', displayName: '王' }, { id: 'b', displayName: '王' }],
    })
    expect(proposal).toMatchObject({ kind: 'clarification' })
    expect(proposal?.parameters).toMatchObject({ reason: 'ambiguous-character' })
    expect((proposal?.parameters.candidates as unknown[])).toHaveLength(2)
  })

  it('resolves the longest matching name rather than refusing on a false ambiguity', () => {
    const [proposal] = parser.parse('把老王设成管理员', {
      worldId: 'world-1',
      characters: [{ id: 'a', displayName: '王' }, { id: 'b', displayName: '老王' }],
    })
    expect(proposal).toMatchObject({ kind: 'authority-update', target: 'character:b' })
  })

  it('splits a compound request into an ordered plan instead of swallowing it', () => {
    const proposals = parser.parse('把当前场景改成产品评审，然后把老王设成管理员', context)
    expect(proposals.map((item) => item.action)).toEqual([
      'world.settings.update',
      'world.authority.update',
    ])
    // The scenario used to become the entire sentence, administrator included.
    expect(proposals[0]?.parameters).toMatchObject({ scenario: '产品评审' })
    expect(JSON.stringify(proposals[0]?.parameters)).not.toContain('管理员')
    expect(proposals.map((item) => item.ordinal)).toEqual([1, 2])
  })

  it('reports a clause it could not compile instead of dropping it', () => {
    const plan = parser.compile('把当前场景改成产品评审，然后请他喝杯咖啡', context)
    expect(plan.proposals).toHaveLength(1)
    expect(plan.unhandled).toEqual(['请老王喝杯咖啡'.replace('老王', '他')])
  })
})

