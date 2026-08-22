import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'

import { WorldAmbientSlotResolver } from '../src/services/world-ambient-slot-resolver.js'
import { WorldAmbientStateProvider } from '../src/services/world-ambient-state-provider.js'

const stores: SqliteStore[] = []

const ENGINEERING_HOME_SLOT_ID = 'work-engineering:slot-1'

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(id: string, displayName: string, role: string): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id,
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName,
    role,
    summary: `${role}角色`,
    persona: `你是${displayName}。`,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-22T00:00:00.000Z',
  }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ambient-state-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地实例' })
  const world = store.createWorld({
    workspaceId: workspace.id,
    name: '赛博公司',
    templateId: 'cyber-company',
  })
  store.saveBlueprint(blueprint('engineer', '开发工程师', '开发工程师'))
  const engineer = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'engineer',
    blueprintVersion: 1,
  })
  const simulationStore = new WorldSimulationStore(store)
  simulationStore.savePresence({
    worldId: world.id,
    characterId: engineer.id,
    sceneId: 'headquarters',
    zoneId: 'zone-engineering',
    homeSlotId: ENGINEERING_HOME_SLOT_ID,
    currentSlotId: ENGINEERING_HOME_SLOT_ID,
    facing: 'south',
    physicalState: 'at-home',
    status: 'available',
    updatedAt: '2026-08-22T09:00:00.000Z',
  })
  return { store, world, engineer, simulationStore }
}

describe('world ambient state provider', () => {
  it('maps durable character presence into an engineering ambient profile', async () => {
    const { store, world, engineer, simulationStore } = await setup()
    const slotResolver = new WorldAmbientSlotResolver({ store })
    const provider = new WorldAmbientStateProvider({
      store,
      simulationStore,
      resolveSlots: (worldId) => slotResolver.resolve(worldId),
    })
    const characters = provider.loadCharacters(world.id)
    expect(characters).toEqual([
      expect.objectContaining({
        characterId: engineer.id,
        currentSlotId: ENGINEERING_HOME_SLOT_ID,
        homeSlotId: ENGINEERING_HOME_SLOT_ID,
        roleTags: expect.arrayContaining(['engineering', 'coding', 'testing']),
        preferredZoneTags: ['engineering'],
      }),
    ])
  })

  it('projects durable occupancy and reservations onto semantic slots', async () => {
    const { store, world, engineer, simulationStore } = await setup()
    const slotResolver = new WorldAmbientSlotResolver({ store })
    const slots = slotResolver.resolve(world.id)
    expect(slots.length).toBeGreaterThan(0)
    const home = slots.find((slot) => slot.id === ENGINEERING_HOME_SLOT_ID)
    expect(home).toBeDefined()
    simulationStore.saveActionPlan({
      id: 'ambient-plan-1',
      worldId: world.id,
      characterId: engineer.id,
      source: 'role-routine',
      reason: '岗位巡检',
      priority: 16,
      interruptible: true,
      status: 'queued',
      steps: [],
      createdAt: '2026-08-22T09:10:00.000Z',
    })
    simulationStore.saveReservations([{
      id: 'reservation-1',
      worldId: world.id,
      slotId: home!.id,
      characterId: engineer.id,
      planId: 'ambient-plan-1',
      status: 'reserved',
      priority: 16,
      reservedAt: '2026-08-22T09:10:00.000Z',
      expiresAt: '2026-08-22T09:12:00.000Z',
      updatedAt: '2026-08-22T09:10:00.000Z',
    }])

    const provider = new WorldAmbientStateProvider({
      store,
      simulationStore,
      resolveSlots: (worldId) => slotResolver.resolve(worldId),
    })
    const resolved = await provider.loadSlots(world.id)
    const selected = resolved.find((slot) => slot.id === home!.id)
    expect(selected).toMatchObject({
      occupiedBy: engineer.id,
      reservedBy: engineer.id,
    })
  })
})
