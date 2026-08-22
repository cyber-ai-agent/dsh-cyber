import { describe, expect, it } from 'vitest'

import type { EmployeeInstance } from '@dsh-cyber/contracts'
import type {
  CharacterBehaviorProfile,
  CompiledWorldSemantics,
  WorldSlotDefinition,
} from '@dsh-cyber/contracts/world-simulation'

import {
  assignCharacterHomeSlots,
  resolveCharacterBehavior,
  selectCharacterSlot,
} from '../src/semantics.js'

const customRole: EmployeeInstance = {
  id: 'custom-quantum-gardener',
  workspaceId: 'workspace-1',
  worldId: 'world-1',
  blueprintId: 'user.custom.quantum-gardener',
  blueprintVersion: 1,
  displayName: '星芽',
  role: '量子园丁',
  status: 'available',
  currentRevision: 1,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}

const configured: CharacterBehaviorProfile = {
  id: 'user.quantum-gardener',
  roleTags: ['botany', 'experiments'],
  preferredZoneTags: ['research'],
  preferredFacilityCapabilities: ['research', 'inspect'],
  allowedZoneTags: ['research', 'meeting', 'rest', 'public'],
  homeSlotTags: ['research', 'home'],
  ambientBehaviors: ['inspect-cultivation-bed'],
  socialPolicy: {
    canInitiateConversation: false,
    cooldownSeconds: 1_800,
    maxDailyConversations: 0,
  },
}

const slots: WorldSlotDefinition[] = [
  slot('admin-home', 'zone-administration', 'home', ['administration', 'home']),
  slot('engineering-home', 'zone-engineering', 'home', ['engineering', 'home']),
  slot('research-home', 'zone-research', 'home', ['research', 'home']),
  slot('research-bench', 'zone-research', 'work', ['research', 'inspect', 'work']),
  slot('public-wait', 'zone-public', 'waiting', ['public', 'waiting']),
]

const semantics: CompiledWorldSemantics = {
  contractVersion: 1,
  themeId: 'test-theme',
  sceneId: 'main',
  zones: [],
  facilities: [],
  slots,
}

describe('custom role semantic placement', () => {
  it('keeps the legacy general fallback when no explicit profile exists', () => {
    expect(resolveCharacterBehavior(customRole).id).toBe('general')
  })

  it('uses the explicit profile without inspecting the custom role name', () => {
    expect(resolveCharacterBehavior(customRole, configured)).toEqual(configured)
    const homes = assignCharacterHomeSlots(
      [customRole],
      semantics,
      new Map(),
      new Map([[customRole.id, configured]]),
    )
    expect(homes.get(customRole.id)?.zoneId).toBe('zone-research')
    expect(homes.get(customRole.id)?.zoneId).not.toBe('zone-administration')
  })

  it('selects task facilities from declared capabilities and allowed zones', () => {
    const selected = selectCharacterSlot(
      customRole,
      semantics,
      new Set(),
      'task',
      configured,
    )
    expect(selected?.id).toBe('research-bench')
    expect(selected?.zoneId).toBe('zone-research')
  })

  it('cannot leak into a semantically disallowed department', () => {
    const restricted: CharacterBehaviorProfile = {
      ...configured,
      preferredZoneTags: ['engineering'],
      preferredFacilityCapabilities: ['coding'],
    }
    const selected = selectCharacterSlot(
      customRole,
      semantics,
      new Set(),
      'task',
      restricted,
    )
    expect(selected?.zoneId).not.toBe('zone-engineering')
  })
})

function slot(
  id: string,
  zoneId: string,
  kind: WorldSlotDefinition['kind'],
  tags: string[],
): WorldSlotDefinition {
  return {
    id,
    sceneId: 'main',
    zoneId,
    anchorId: id,
    kind,
    position: { x: slotsLength(id) * 100, y: 100 },
    facing: 'south',
    posture: kind === 'work' || kind === 'seat' ? 'sit' : 'stand',
    capacity: 1,
    exclusive: true,
    tags,
  }
}

function slotsLength(value: string): number {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) % 10
  return hash
}
