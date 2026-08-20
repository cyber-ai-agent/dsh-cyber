import { describe, expect, it } from 'vitest'

import type { DomainEvent, EmployeeInstance, World } from '@dsh-cyber/contracts'

import {
  cyberCompanyTheme,
  findPath,
  projectWorldRuntime,
  validateWorldThemeManifest,
} from '../src/index.js'

const world: World = {
  id: 'world-company',
  workspaceId: 'workspace-1',
  name: '赛博公司',
  templateId: 'company',
  status: 'active',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const employees: EmployeeInstance[] = [
  {
    id: 'employee-architect',
    workspaceId: 'workspace-1',
    worldId: world.id,
    blueprintId: 'architect',
    blueprintVersion: 1,
    displayName: '老周',
    role: '架构师',
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'employee-engineer',
    workspaceId: 'workspace-1',
    worldId: world.id,
    blueprintId: 'engineer',
    blueprintVersion: 1,
    displayName: '阿帆',
    role: '开发工程师',
    status: 'working',
    currentRevision: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
]

function event(sequence: number, type: DomainEvent['type'], payload: DomainEvent['payload']): DomainEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: 'workspace-1',
    worldId: world.id,
    sequence,
    type,
    actorId: 'employee-architect',
    actorKind: 'employee',
    payload,
    createdAt: `2026-08-20T00:00:0${sequence}.000Z`,
  }
}

describe('world theme manifest', () => {
  it('validates the built-in company theme', () => {
    expect(validateWorldThemeManifest(cyberCompanyTheme)).toEqual({ valid: true, errors: [] })
  })

  it('rejects missing asset and anchor references', () => {
    const broken = structuredClone(cyberCompanyTheme)
    broken.scenes[0]!.layers[0]!.assetId = 'missing'
    broken.scenes[0]!.interactables[0]!.approachAnchorIds = ['missing']
    const result = validateWorldThemeManifest(broken)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('missing asset')
    expect(result.errors.join(' ')).toContain('missing anchor')
  })
})

describe('world navigation', () => {
  it('finds a deterministic route around blocked cells', () => {
    const path = findPath(
      {
        origin: { x: 0, y: 0 },
        cellSize: 10,
        columns: 5,
        rows: 5,
        blocked: ['1,0', '1,1', '1,2'],
      },
      { x: 5, y: 5 },
      { x: 45, y: 5 },
    )
    expect(path.length).toBeGreaterThan(4)
    expect(path.at(-1)).toEqual({ x: 45, y: 5 })
  })

  it('returns an empty route when no path exists', () => {
    const path = findPath(
      {
        origin: { x: 0, y: 0 },
        cellSize: 10,
        columns: 3,
        rows: 3,
        blocked: ['1,0', '1,1', '1,2'],
      },
      { x: 5, y: 5 },
      { x: 25, y: 5 },
    )
    expect(path).toEqual([])
  })
})

describe('world projector', () => {
  it('projects independent agents, a meeting route, speech and growth cues', () => {
    const result = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees,
      manifest: cyberCompanyTheme,
      now: '2026-08-20T00:00:10.000Z',
      events: [
        event(1, 'meeting.started', { participantIds: employees.map((employee) => employee.id) }),
        event(2, 'message.appended', {
          employeeId: 'employee-engineer',
          senderId: 'employee-engineer',
          messageKind: 'assistant',
          messageId: 'message-1',
        }),
        event(3, 'employee.milestone.recorded', {
          employeeId: 'employee-architect',
          milestoneId: 'milestone-1',
          category: 'skill',
        }),
      ],
    })
    expect(result.snapshot.entities).toHaveLength(2)
    expect(result.snapshot.entities.every((entity) => entity.activity === 'meeting' || entity.id === 'employee-engineer')).toBe(true)
    expect(result.cues.some((cue) => cue.kind === 'meeting.gather')).toBe(true)
    expect(result.cues.some((cue) => cue.kind === 'entity.speech')).toBe(true)
    expect(result.cues.some((cue) => cue.kind === 'growth.unlocked')).toBe(true)
  })

  it('does not reapply events that are already in the previous snapshot', () => {
    const first = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees,
      manifest: cyberCompanyTheme,
      events: [event(1, 'task.started', { employeeId: 'employee-architect' })],
    })
    const replay = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees,
      manifest: cyberCompanyTheme,
      events: [event(1, 'task.started', { employeeId: 'employee-architect' })],
      previous: first.snapshot,
    })
    expect(replay.cues).toEqual([])
    expect(replay.snapshot.sequence).toBe(1)
  })

  it('keeps semantic and visual movement state separate until a real task completes', () => {
    const started = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees: [{ ...employees[0]!, status: 'working' }],
      manifest: cyberCompanyTheme,
      events: [event(1, 'task.started', { employeeId: 'employee-architect' })],
    })
    const moving = started.snapshot.entities.find((entity) => entity.id === 'employee-architect')!
    expect(moving.targetPosition).toBeDefined()
    expect(moving.position).not.toEqual(moving.targetPosition)
    expect(started.cues).toContainEqual(expect.objectContaining({ kind: 'entity.route', entityId: moving.id }))

    const completed = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees: [{ ...employees[0]!, status: 'available' }],
      manifest: cyberCompanyTheme,
      previous: started.snapshot,
      events: [event(2, 'task.completed', { employeeId: 'employee-architect' })],
    })
    const settled = completed.snapshot.entities.find((entity) => entity.id === 'employee-architect')!
    expect(settled.targetPosition).toBeUndefined()
    expect(settled.anchorId).toBeDefined()
    expect(settled.activity).toBe('idle')
  })

  it('keeps participant turns at the meeting table until the meeting finishes', () => {
    const meeting = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees,
      manifest: cyberCompanyTheme,
      events: [
        event(1, 'meeting.started', { participantIds: employees.map((employee) => employee.id) }),
        event(2, 'task.started', { employeeId: 'employee-architect' }),
        event(3, 'turn.started', { employeeId: 'employee-architect' }),
      ],
    })
    const participant = meeting.snapshot.entities.find((entity) => entity.id === 'employee-architect')!
    expect(participant.targetAnchorId).toMatch(/^meeting-/)
    expect(participant.visualState['activeMeetingId']).toBe('event-1')

    const finished = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees,
      manifest: cyberCompanyTheme,
      previous: meeting.snapshot,
      events: [event(4, 'meeting.finished', { participantIds: employees.map((employee) => employee.id) })],
    })
    const returning = finished.snapshot.entities.find((entity) => entity.id === 'employee-architect')!
    expect(returning.targetAnchorId).toMatch(/^work-/)
    expect(returning.visualState['activeMeetingId']).toBeUndefined()
  })
})
