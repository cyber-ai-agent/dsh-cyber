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

  it('keeps a compound administrator request all-or-none in one proposal', () => {
    const [proposal] = parser.parse('把老王也设置成管理员，给他世界设置、角色管理和文件读写权限', context)
    expect(proposal).toMatchObject({ kind: 'authority-update', action: 'world.authority.update' })
    expect(proposal?.parameters).toMatchObject({
      role: 'administrator',
      permissionGrants: [
        'world.settings.write',
        'world.characters.manage',
        'world.files.read',
        'world.files.write',
      ],
    })
  })

  it('rejects ambiguous character names instead of guessing a target', () => {
    expect(parser.parse('把王设置成管理员', {
      worldId: 'world-1',
      characters: [{ id: 'a', displayName: '王' }, { id: 'b', displayName: '王' }],
    })).toEqual([])
  })
})

