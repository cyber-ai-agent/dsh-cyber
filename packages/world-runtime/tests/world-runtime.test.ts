import { describe, expect, it } from 'vitest'

import type { DomainEvent, EmployeeInstance, World } from '@dsh-cyber/contracts'

import {
  aiAcademyTheme,
  cyberCompanyTheme,
  findPath,
  jarvisCoreTheme,
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

  it('validates the built-in AI academy theme and its classroom scene', () => {
    expect(validateWorldThemeManifest(aiAcademyTheme)).toEqual({ valid: true, errors: [] })
    const scene = aiAcademyTheme.scenes[0]!
    expect(scene.id).toBe('university-classroom')
    expect(scene.interactables.map((item) => item.id)).toEqual([
      'knowledge-breakdown-desk',
      'syllabus-board',
      'teaching-material-bench',
      'question-desk',
      'knowledge-graph-wall',
      'course-result-showcase',
      'lecture-blackboard',
      'cohort-seating',
    ])
  })

  it('validates the built-in Jarvis Core theme and its personal hub scene', () => {
    expect(validateWorldThemeManifest(jarvisCoreTheme)).toEqual({ valid: true, errors: [] })
    const scene = jarvisCoreTheme.scenes[0]!
    expect(scene.id).toBe('personal-hub-studio')
    expect(scene.interactables.map((item) => item.id)).toEqual([
      'request-intake-table',
      'ownership-routing-board',
      'delegation-board',
      'research-carrel-desk',
      'schedule-console-desk',
      'filing-organiser-bench',
      'information-index-wall',
      'summary-report-stand',
    ])
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

  it.each([
    ['unknown root field', () => ({ ...structuredClone(cyberCompanyTheme), injected: true })],
    ['invalid renderer', () => ({ ...structuredClone(cyberCompanyTheme), renderer: 'canvas-2d' })],
    ['invalid terminology', () => ({ ...structuredClone(cyberCompanyTheme), terminology: [] })],
    ['non-JSON terminology number', () => ({
      ...structuredClone(cyberCompanyTheme),
      terminology: { nested: [Number.POSITIVE_INFINITY] },
    })],
    ['duplicate asset', () => {
      const value = structuredClone(cyberCompanyTheme)
      value.assets.push({ ...value.assets[0]! })
      return value
    }],
    ['invalid frame', () => {
      const value = structuredClone(cyberCompanyTheme)
      value.actorSets[0]!.clips.walking.south = [-1]
      return value
    }],
    ['actor set references a non-spritesheet asset', () => {
      const value = structuredClone(cyberCompanyTheme)
      value.actorSets[0]!.assetId = value.assets.find((asset) => asset.kind === 'image')!.id
      return value
    }],
    ['activity has no directional fallback frame', () => {
      const value = structuredClone(cyberCompanyTheme)
      value.actorSets[0]!.clips.walking = {}
      return value
    }],
    ['duplicate blocked cell', () => {
      const value = structuredClone(cyberCompanyTheme)
      value.scenes[0]!.navigation.blocked.push(value.scenes[0]!.navigation.blocked[0]!)
      return value
    }],
    ['invalid activity mapping', () => ({ ...structuredClone(cyberCompanyTheme), activityMapping: { event: 'flying' } })],
    ['missing required activity mapping', () => {
      const value = structuredClone(cyberCompanyTheme)
      Reflect.deleteProperty(value.activityMapping, 'task.started')
      return value
    }],
  ])('rejects malformed theme: %s', (_name, createValue) => {
    expect(validateWorldThemeManifest(createValue()).valid).toBe(false)
  })

  it('rejects extreme navigation dimensions', () => {
    const value = structuredClone(cyberCompanyTheme)
    value.scenes[0]!.navigation.columns = 4_096
    value.scenes[0]!.navigation.rows = 4_096
    const result = validateWorldThemeManifest(value)
    expect(result.valid).toBe(false)
    expect(result.errors.join(' ')).toContain('navigation cells')
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

  it('keeps task intent separate from visual travel and works in place when already at the correct slot', () => {
    const started = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees: [{ ...employees[0]!, status: 'working' }],
      manifest: cyberCompanyTheme,
      events: [event(1, 'task.started', { employeeId: 'employee-architect' })],
    })
    const active = started.snapshot.entities.find((entity) => entity.id === 'employee-architect')!
    expect(active.activity).toBe('working')
    expect(active.visualState['activePlanId']).toBeDefined()

    if (active.targetPosition !== undefined) {
      expect(active.position).not.toEqual(active.targetPosition)
      expect(started.cues).toContainEqual(expect.objectContaining({ kind: 'entity.route', entityId: active.id }))
      expect(active.visualState['reservedSlotId']).toBeDefined()
    } else {
      expect(active.visualState['currentSlotId']).toBeDefined()
      expect(active.visualState['physicalState']).toBe('working')
    }

    const completed = projectWorldRuntime({
      workspaceId: 'workspace-1',
      world,
      employees: [{ ...employees[0]!, status: 'available' }],
      manifest: cyberCompanyTheme,
      previous: started.snapshot,
      events: [event(2, 'task.completed', { employeeId: 'employee-architect' })],
    })
    const settled = completed.snapshot.entities.find((entity) => entity.id === 'employee-architect')!
    const homeSlotId = settled.visualState['homeSlotId']
    expect(typeof homeSlotId).toBe('string')
    expect(settled.activity).toBe('idle')
    if (settled.targetPosition === undefined) {
      expect(settled.visualState['currentSlotId']).toBe(homeSlotId)
    } else {
      expect(settled.visualState['reservedSlotId']).toBe(homeSlotId)
    }
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
