import { describe, expect, it } from 'vitest'

import {
  RECOMMENDED_ADMIN_PERMISSIONS,
  WORLD_CHARACTER_PERMISSION_DESCRIPTORS,
  WORLD_CHARACTER_PERMISSIONS,
} from '../src/index.js'

describe('World artifact contracts', () => {
  it('keeps artifact and knowledge permissions in the shared authority vocabulary', () => {
    expect(WORLD_CHARACTER_PERMISSIONS).toEqual(expect.arrayContaining([
      'world.artifacts.read',
      'world.artifacts.manage',
      'world.knowledge.read',
      'world.knowledge.manage',
    ]))
    expect(RECOMMENDED_ADMIN_PERMISSIONS).toEqual(expect.arrayContaining([
      'world.artifacts.read',
      'world.artifacts.manage',
      'world.knowledge.read',
      'world.knowledge.manage',
    ]))
    expect(WORLD_CHARACTER_PERMISSION_DESCRIPTORS).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'world.artifacts.read', management: false }),
      expect.objectContaining({ id: 'world.artifacts.manage', management: true }),
      expect.objectContaining({ id: 'world.knowledge.read', management: false }),
      expect.objectContaining({ id: 'world.knowledge.manage', management: true }),
    ]))
  })
})
