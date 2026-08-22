import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  CharacterActionPlan,
  CharacterPresence,
  SharedWorldEpisode,
  WorldSlotReservation,
} from '@dsh-cyber/contracts/world-simulation'

import { SqliteStore, WorldSimulationStore } from '../src/index.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('WorldSimulationStore', () => {
  it('persists presence, plans, reservations and shared episodes across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-world-simulation-'))
    const databasePath = join(directory, 'cyber.sqlite')
    const first = await SqliteStore.open(databasePath)
    stores.push(first)
    const workspace = first.createWorkspace({ name: '本地实例' })
    const world = first.createWorld({ workspaceId: workspace.id, name: '赛博公司', templateId: 'cyber-company' })
    first.saveBlueprint({
      schemaVersion: 1,
      id: 'cyber-company.software-engineer',
      version: 1,
      worldTemplateId: 'cyber-company',
      displayName: '开发工程师',
      role: '软件工程师',
      summary: '负责软件交付',
      persona: '先澄清，再实现和验证。',
      requestedSkills: ['coding'],
      requestedCapabilities: [],
      createdAt: '2026-08-22T00:00:00.000Z',
    })
    const character = first.recruitEmployee({
      workspaceId: workspace.id,
      worldId: world.id,
      blueprintId: 'cyber-company.software-engineer',
      blueprintVersion: 1,
    })
    const simulation = new WorldSimulationStore(first)

    const plan: CharacterActionPlan = {
      id: 'plan-engineer-work',
      worldId: world.id,
      characterId: character.id,
      source: 'task',
      reason: '前往研发区执行任务',
      priority: 80,
      interruptible: false,
      status: 'running',
      steps: [{
        id: 'plan-engineer-work:step-1',
        planId: 'plan-engineer-work',
        sequence: 1,
        kind: 'navigate-to-slot',
        payload: { slotId: 'work-engineering:slot-1' },
        status: 'running',
        startedAt: '2026-08-22T00:00:01.000Z',
      }],
      createdAt: '2026-08-22T00:00:00.000Z',
      startedAt: '2026-08-22T00:00:01.000Z',
    }
    simulation.saveActionPlan(plan)

    const reservation: WorldSlotReservation = {
      id: 'reservation-engineer-work',
      worldId: world.id,
      slotId: 'work-engineering:slot-1',
      characterId: character.id,
      planId: plan.id,
      status: 'reserved',
      priority: 80,
      reservedAt: '2026-08-22T00:00:01.000Z',
      expiresAt: '2026-08-22T00:05:00.000Z',
      updatedAt: '2026-08-22T00:00:01.000Z',
    }
    simulation.saveReservations([reservation])

    const presence: CharacterPresence = {
      worldId: world.id,
      characterId: character.id,
      sceneId: 'headquarters',
      zoneId: 'zone-engineering',
      homeSlotId: 'work-engineering:slot-1',
      currentSlotId: 'work-engineering:slot-1',
      reservedSlotId: 'work-engineering:slot-1',
      facing: 'north',
      physicalState: 'working',
      status: 'working',
      activePlanId: plan.id,
      activeSessionId: 'session-engineer',
      updatedAt: '2026-08-22T00:00:01.000Z',
    }
    simulation.savePresence(presence)

    const episode: SharedWorldEpisode = {
      id: 'episode-1',
      worldId: world.id,
      participantIds: [character.id],
      kind: 'collaboration',
      title: '完成首次开发任务',
      summary: '开发工程师完成了一次有证据的交付。',
      outcome: '通过验证',
      sourceEventIds: ['event-1'],
      sourceMessageIds: ['message-1'],
      importance: 70,
      occurredAt: '2026-08-22T00:04:00.000Z',
      createdAt: '2026-08-22T00:04:01.000Z',
    }
    simulation.recordSharedEpisode(episode)

    first.close()
    stores.splice(stores.indexOf(first), 1)

    const reopened = await SqliteStore.open(databasePath)
    stores.push(reopened)
    const restored = new WorldSimulationStore(reopened)
    expect(restored.getPresence(character.id)).toEqual(presence)
    expect(restored.getActionPlan(plan.id)).toEqual(plan)
    expect(restored.listReservations(world.id)).toEqual([reservation])
    expect(restored.listSharedEpisodes(world.id, character.id)).toEqual([episode])

    expect(restored.cleanupExpiredReservations('2026-08-22T00:06:00.000Z')).toBe(1)
    expect(restored.listReservations(world.id)).toEqual([])
  })
})
