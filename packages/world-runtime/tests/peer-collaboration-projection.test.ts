import { describe, expect, it } from 'vitest'

import type { DomainEvent, EmployeeInstance, World } from '@dsh-cyber/contracts'

import { cyberCompanyTheme, projectWorldRuntime } from '../src/index.js'

const world: World = {
  id: 'world-peer',
  workspaceId: 'workspace-peer',
  name: '赛博公司',
  templateId: 'cyber-company',
  status: 'active',
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}

const secretary = employee('secretary', '林秘书', '行政秘书')
const engineer = employee('engineer', '小刘', '开发工程师')

function employee(id: string, displayName: string, role: string): EmployeeInstance {
  return {
    id,
    workspaceId: world.workspaceId,
    worldId: world.id,
    blueprintId: id,
    blueprintVersion: 1,
    displayName,
    role,
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  }
}

function event(sequence: number, type: DomainEvent['type'], actorId: string, payload: DomainEvent['payload']): DomainEvent {
  return {
    id: `peer-event-${sequence}`,
    workspaceId: world.workspaceId,
    worldId: world.id,
    sessionId: 'peer-session',
    sequence,
    type,
    actorId,
    actorKind: actorId === 'system' ? 'system' : 'employee',
    correlationId: 'peer-session',
    payload,
    createdAt: `2026-08-22T00:00:0${sequence}.000Z`,
  }
}

describe('peer collaboration world projection', () => {
  it('renders one real speaker while the other meeting participant listens', () => {
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees: [secretary, engineer],
      manifest: cyberCompanyTheme,
      events: [
        event(1, 'meeting.started', secretary.id, {
          participantIds: [secretary.id, engineer.id],
          initiatorId: secretary.id,
          peerConversation: true,
        }),
        event(2, 'turn.started', engineer.id, { employeeId: engineer.id }),
        event(3, 'message.appended', engineer.id, {
          employeeId: engineer.id,
          senderId: engineer.id,
          messageKind: 'assistant',
          messageId: 'message-engineer',
          excerpt: '接口已完成，剩余端到端验证。',
        }),
      ],
    })

    const visibleEngineer = result.snapshot.entities.find((entity) => entity.id === engineer.id)!
    const visibleSecretary = result.snapshot.entities.find((entity) => entity.id === secretary.id)!
    expect(visibleEngineer.activity).toBe('talking')
    expect(visibleEngineer.visualState['physicalState']).toBe('speaking')
    expect(visibleSecretary.activity).toBe('meeting')
    expect(visibleSecretary.visualState['physicalState']).toBe('listening')
    expect(visibleSecretary.activityLabel).toContain('小刘')
    expect(result.cues).toContainEqual(expect.objectContaining({
      kind: 'entity.speech',
      entityId: engineer.id,
      payload: expect.objectContaining({ excerpt: '接口已完成，剩余端到端验证。' }),
    }))
  })

  it('keeps completed speakers in the meeting until the collaboration finishes', () => {
    const meeting = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees: [secretary, engineer],
      manifest: cyberCompanyTheme,
      events: [
        event(1, 'meeting.started', secretary.id, {
          participantIds: [secretary.id, engineer.id],
          peerConversation: true,
        }),
        event(2, 'task.completed', engineer.id, { employeeId: engineer.id }),
      ],
    })
    const visibleEngineer = meeting.snapshot.entities.find((entity) => entity.id === engineer.id)!
    expect(visibleEngineer.activity).toBe('meeting')
    expect(visibleEngineer.visualState['physicalState']).toBe('listening')
    expect(visibleEngineer.visualState['activeMeetingId']).toBe('peer-session')

    const finished = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees: [secretary, engineer],
      manifest: cyberCompanyTheme,
      previous: meeting.snapshot,
      events: [event(3, 'meeting.finished', 'system', {
        participantIds: [secretary.id, engineer.id],
        peerConversation: true,
        status: 'completed',
      })],
    })
    expect(finished.snapshot.entities.every((entity) => entity.visualState['activeMeetingId'] === undefined)).toBe(true)
  })
})
