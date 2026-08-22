import { describe, expect, it } from 'vitest'

import type {
  DomainEvent,
  EmployeeInstance,
  World,
  WorldRuntimeSnapshot,
} from '@dsh-cyber/contracts'

import { cyberCompanyTheme, projectWorldRuntime } from '../src/index.js'

const world: World = {
  id: 'world-embodied',
  workspaceId: 'workspace-1',
  name: '赛博公司',
  templateId: 'cyber-company',
  status: 'active',
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}

const secretary = character('secretary', 'cyber-company.secretary', '秘书', '秘书')
const engineer = character('engineer', 'cyber-company.software-engineer', '开发工程师', '软件工程师')
const archivist = character('archivist', 'cyber-company.archivist', '档案管理员', '知识与档案管理员')
const employees = [secretary, engineer, archivist]

describe('embodied world runtime projection', () => {
  it('places each role in a deterministic non-overlapping semantic home zone', () => {
    const first = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      events: [],
      manifest: cyberCompanyTheme,
      now: '2026-08-22T00:00:10.000Z',
    })
    const byId = new Map(first.snapshot.entities.map((entity) => [entity.id, entity]))

    expect(byId.get(secretary.id)?.visualState['zoneId']).toBe('zone-administration')
    expect(byId.get(engineer.id)?.visualState['zoneId']).toBe('zone-engineering')
    expect(byId.get(archivist.id)?.visualState['zoneId']).toBe('zone-research')
    expect(new Set(first.snapshot.entities.map((entity) => `${entity.position.x}:${entity.position.y}`)).size)
      .toBe(first.snapshot.entities.length)

    const repeated = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees: [...employees].reverse(),
      events: [],
      manifest: cyberCompanyTheme,
      now: '2026-08-22T00:00:10.000Z',
    })
    expect(repeated.snapshot.entities.map(identityAndHome))
      .toEqual(first.snapshot.entities.map(identityAndHome))
  })

  it('drives thinking and speech state only on the addressed conversation character', () => {
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      events: [
        event(1, 'turn.started', secretary.id, { employeeId: secretary.id }),
        event(2, 'message.appended', secretary.id, {
          employeeId: secretary.id,
          senderId: secretary.id,
          messageKind: 'assistant',
          messageId: 'message-secretary',
          excerpt: '我去向开发工程师确认进度。',
        }),
      ],
      manifest: cyberCompanyTheme,
      now: '2026-08-22T00:00:10.000Z',
    })
    const secretaryEntity = result.snapshot.entities.find((entity) => entity.id === secretary.id)!
    const engineerEntity = result.snapshot.entities.find((entity) => entity.id === engineer.id)!

    expect(secretaryEntity.activity).toBe('talking')
    expect(secretaryEntity.visualState['activeSessionId']).toBe('session-1')
    expect(engineerEntity.activity).toBe('idle')
    expect(result.cues).toContainEqual(expect.objectContaining({
      kind: 'entity.speech',
      entityId: secretary.id,
      payload: expect.objectContaining({ excerpt: '我去向开发工程师确认进度。' }),
    }))
    expect(result.cues.some((cue) => cue.entityId === engineer.id && cue.kind === 'entity.speech')).toBe(false)
  })

  it('routes an engineer from a shared area back to an engineering work slot for a real task', () => {
    const initial = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      events: [],
      manifest: cyberCompanyTheme,
      now: '2026-08-22T00:00:00.000Z',
    }).snapshot
    const moved = moveCharacterToLounge(initial, engineer.id)
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees: employees.map((employee) => employee.id === engineer.id ? { ...employee, status: 'working' } : employee),
      events: [event(1, 'task.started', engineer.id, { employeeId: engineer.id, role: engineer.role })],
      manifest: cyberCompanyTheme,
      previous: moved,
      now: '2026-08-22T00:00:05.000Z',
    })
    const projected = result.snapshot.entities.find((entity) => entity.id === engineer.id)!

    expect(projected.visualState['zoneId']).toBe('zone-engineering')
    expect(projected.visualState['reservedSlotId']).toMatch(/^work-engineering:slot-/)
    expect(projected.targetAnchorId).toBe('work-engineering')
    expect(result.cues).toContainEqual(expect.objectContaining({ kind: 'entity.route', entityId: engineer.id }))
  })

  it('allocates different meeting seats to each participant', () => {
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      events: [event(1, 'meeting.started', 'owner', { participantIds: employees.map((employee) => employee.id) }, 'owner')],
      manifest: cyberCompanyTheme,
      now: '2026-08-22T00:00:05.000Z',
    })
    const participants = result.snapshot.entities.filter((entity) => employees.some((employee) => employee.id === entity.id))
    expect(new Set(participants.map((entity) => entity.visualState['reservedSlotId'])).size).toBe(participants.length)
    expect(new Set(participants.map((entity) => `${entity.targetPosition?.x}:${entity.targetPosition?.y}`)).size)
      .toBe(participants.length)
  })
})

function character(id: string, blueprintId: string, displayName: string, role: string): EmployeeInstance {
  return {
    id,
    workspaceId: world.workspaceId,
    worldId: world.id,
    blueprintId,
    blueprintVersion: 1,
    displayName,
    role,
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  }
}

function event(
  sequence: number,
  type: DomainEvent['type'],
  actorId: string,
  payload: DomainEvent['payload'],
  actorKind: DomainEvent['actorKind'] = 'employee',
): DomainEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: world.workspaceId,
    worldId: world.id,
    sessionId: 'session-1',
    sequence,
    type,
    actorId,
    actorKind,
    payload,
    createdAt: `2026-08-22T00:00:0${sequence}.000Z`,
  }
}

function identityAndHome(entity: WorldRuntimeSnapshot['entities'][number]): [string, unknown] {
  return [entity.id, entity.visualState['homeSlotId']]
}

function moveCharacterToLounge(snapshot: WorldRuntimeSnapshot, characterId: string): WorldRuntimeSnapshot {
  return {
    ...snapshot,
    entities: snapshot.entities.map((entity) => entity.id !== characterId ? entity : {
      ...entity,
      position: { x: 1110, y: 740 },
      anchorId: 'lounge',
      route: [],
      visualState: {
        ...entity.visualState,
        zoneId: 'zone-rest',
        currentSlotId: 'lounge:slot-1',
        physicalState: 'at-home',
      },
    }),
  }
}
