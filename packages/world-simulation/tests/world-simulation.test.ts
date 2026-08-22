import { describe, expect, it } from 'vitest'

import type { DomainEvent, EmployeeInstance, WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import {
  CHARACTER_ACTION_PRIORITIES,
  WorldSlotReservationLedger,
  assignCharacterHomeSlots,
  canInterruptActionPlan,
  compileWorldSemantics,
  directWorldEvent,
  resolveCharacterBehavior,
  selectCharacterSlot,
} from '../src/index.js'

const theme: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'test.company',
  version: '1.0.0',
  templateId: 'company',
  displayName: 'Test Company',
  renderer: 'pixi-2d',
  terminology: {},
  assets: [{ id: 'scene', src: '/scene.png', kind: 'image', preload: true }],
  actorSets: [],
  scenes: [{
    id: 'office',
    displayName: 'Office',
    size: { width: 1_200, height: 800 },
    cameraBounds: { x: 0, y: 0, width: 1_200, height: 800 },
    safeArea: { x: 20, y: 20, width: 1_160, height: 760 },
    layers: [{ id: 'scene', assetId: 'scene', destination: { x: 0, y: 0, width: 1_200, height: 800 }, zIndex: 0 }],
    anchors: [
      { id: 'admin-desk', position: { x: 180, y: 220 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'coordination'] },
      { id: 'engineering-desk', position: { x: 700, y: 220 }, facing: 'north', capacity: 2, tags: ['work', 'engineering', 'coding', 'testing'] },
      { id: 'archive-desk', position: { x: 420, y: 520 }, facing: 'north', capacity: 1, tags: ['work', 'research', 'archive'] },
      { id: 'meeting', position: { x: 900, y: 550 }, facing: 'west', capacity: 4, tags: ['meeting'] },
      { id: 'lounge', position: { x: 200, y: 650 }, facing: 'south', capacity: 3, tags: ['idle', 'rest', 'talk'] },
    ],
    navigation: { origin: { x: 0, y: 0 }, cellSize: 40, columns: 30, rows: 20, blocked: [] },
    interactables: [
      { id: 'workstation', kind: 'workstation', displayName: '研发工作站', bounds: { x: 600, y: 100, width: 250, height: 180 }, approachAnchorIds: ['engineering-desk'], actions: [{ id: 'assign-task', label: '安排任务' }], zIndex: 100 },
      { id: 'meeting-table', kind: 'meeting-table', displayName: '会议桌', bounds: { x: 820, y: 460, width: 250, height: 180 }, approachAnchorIds: ['meeting'], actions: [{ id: 'start-meeting', label: '召集会议' }], zIndex: 100 },
    ],
    growthSlots: [],
  }],
  activityMapping: {},
}

const characters: EmployeeInstance[] = [
  character('secretary', 'cyber-company.secretary', '秘书'),
  character('engineer', 'cyber-company.software-engineer', '开发工程师'),
  character('archivist', 'cyber-company.archivist', '档案管理员'),
]

describe('semantic world compilation', () => {
  it('assigns roles to deterministic non-overlapping home slots', () => {
    const semantics = compileWorldSemantics(theme)
    const homes = assignCharacterHomeSlots(characters, semantics)

    expect(homes.get('secretary')?.zoneId).toBe('zone-administration')
    expect(homes.get('engineer')?.zoneId).toBe('zone-engineering')
    expect(homes.get('archivist')?.zoneId).toBe('zone-research')
    expect(new Set([...homes.values()].map((slot) => slot.id)).size).toBe(homes.size)

    const repeated = assignCharacterHomeSlots([...characters].reverse(), semantics)
    expect([...repeated.entries()].map(([id, slot]) => [id, slot.id]))
      .toEqual([...homes.entries()].map(([id, slot]) => [id, slot.id]))
  })

  it('chooses an engineering work slot for an engineer task', () => {
    const semantics = compileWorldSemantics(theme)
    const selected = selectCharacterSlot(characters[1]!, semantics, new Set(), 'task')
    expect(selected).toMatchObject({ zoneId: 'zone-engineering', kind: 'work' })
    expect(resolveCharacterBehavior(characters[1]!).roleTags).toContain('engineering')
  })
})

describe('slot reservations', () => {
  it('reserves meeting seats atomically and rejects conflicts', () => {
    const semantics = compileWorldSemantics(theme)
    const meetingSlots = semantics.slots.filter((slot) => slot.zoneId === 'zone-meeting').slice(0, 2)
    const ledger = new WorldSlotReservationLedger()
    const first = ledger.reserve({
      reservationIdPrefix: 'meeting-1',
      worldId: 'world-1',
      characterIds: ['secretary', 'engineer'],
      slots: meetingSlots,
      planId: 'plan-1',
      priority: CHARACTER_ACTION_PRIORITIES.conversation,
      now: '2026-08-22T00:00:00.000Z',
      expiresAt: '2026-08-22T00:05:00.000Z',
    })
    expect(first.accepted).toBe(true)

    const conflict = ledger.reserve({
      reservationIdPrefix: 'meeting-2',
      worldId: 'world-1',
      characterIds: ['archivist', 'other'],
      slots: meetingSlots,
      planId: 'plan-2',
      priority: CHARACTER_ACTION_PRIORITIES.conversation,
      now: '2026-08-22T00:00:10.000Z',
      expiresAt: '2026-08-22T00:05:00.000Z',
    })
    expect(conflict).toMatchObject({ accepted: false, reason: 'slot-conflict', reservations: [] })
  })
})

describe('world director', () => {
  it('directs only the addressed character and respects action priority', () => {
    const semantics = compileWorldSemantics(theme)
    const event = domainEvent(1, 'turn.started', 'secretary')
    const directive = directWorldEvent({
      event,
      character: characters[0]!,
      semantics,
      occupiedSlotIds: new Set(),
    })
    expect(directive).toMatchObject({ characterId: 'secretary', physicalState: 'thinking', activity: 'thinking' })
    expect(directWorldEvent({ event, character: characters[1]!, semantics, occupiedSlotIds: new Set() })).toBeUndefined()

    expect(canInterruptActionPlan(
      { priority: CHARACTER_ACTION_PRIORITIES.ambient, interruptible: true, status: 'running' },
      { priority: CHARACTER_ACTION_PRIORITIES.user },
    )).toBe(true)
    expect(canInterruptActionPlan(
      { priority: CHARACTER_ACTION_PRIORITIES.task, interruptible: false, status: 'running' },
      { priority: CHARACTER_ACTION_PRIORITIES.conversation },
    )).toBe(false)
  })
})

function character(id: string, blueprintId: string, role: string): EmployeeInstance {
  return {
    id,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId,
    blueprintVersion: 1,
    displayName: role,
    role,
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  }
}

function domainEvent(sequence: number, type: DomainEvent['type'], employeeId: string): DomainEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    sessionId: 'session-1',
    sequence,
    type,
    actorId: employeeId,
    actorKind: 'employee',
    payload: { employeeId },
    createdAt: `2026-08-22T00:00:0${sequence}.000Z`,
  }
}
