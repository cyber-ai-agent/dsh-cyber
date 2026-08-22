import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmployeeBlueprint } from '@dsh-cyber/contracts'
import { SqliteStore, WorldSimulationStore } from '@dsh-cyber/persistence'
import type { AmbientDecision } from '@dsh-cyber/world-simulation'
import { createAmbientActionPlan } from '@dsh-cyber/world-simulation'

import { AmbientLifeExecutor } from '../src/services/ambient-life-executor.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'engineer',
    version: 1,
    worldTemplateId: 'cyber-company',
    displayName: '开发工程师',
    role: '开发工程师',
    summary: '开发角色',
    persona: '你是开发工程师。',
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-22T00:00:00.000Z',
  }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ambient-executor-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地实例' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '公司', templateId: 'cyber-company' })
  store.saveBlueprint(blueprint())
  const character = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'engineer',
    blueprintVersion: 1,
  })
  const simulationStore = new WorldSimulationStore(store)
  simulationStore.savePresence({
    worldId: world.id,
    characterId: character.id,
    sceneId: 'headquarters',
    zoneId: 'zone-engineering',
    homeSlotId: 'work-engineering:slot-1',
    currentSlotId: 'work-engineering:slot-1',
    reservedSlotId: 'work-engineering:slot-2',
    facing: 'south',
    physicalState: 'navigating',
    status: 'available',
    activePlanId: 'pending-plan',
    updatedAt: '2026-08-22T10:00:00.000Z',
  })
  return { store, world, character, simulationStore }
}

describe('AmbientLifeExecutor', () => {
  it('starts plans through a durable semantic world event', async () => {
    const { store, world, character, simulationStore } = await setup()
    const decision: AmbientDecision = {
      characterId: character.id,
      kind: 'inspect-work-area',
      source: 'role-routine',
      reason: '岗位巡检',
      priority: 16,
      interruptible: true,
      targetSlotId: 'work-engineering:slot-2',
      decisionKey: 'decision-1',
    }
    const plan = createAmbientActionPlan(decision, {
      worldId: world.id,
      now: '2026-08-22T10:00:00.000Z',
      idFactory: (scope) => scope.replaceAll(':', '-'),
    })
    simulationStore.saveActionPlan(plan)
    const executor = new AmbientLifeExecutor({
      store,
      simulationStore,
      clock: () => '2026-08-22T10:00:01.000Z',
    })

    const eventIds = executor.start({
      worldId: world.id,
      generatedAt: '2026-08-22T10:00:00.000Z',
      decisions: [decision],
      plans: [plan],
      skippedCharacterIds: [],
      persistedPlanIds: [plan.id],
    })
    expect(eventIds).toHaveLength(1)
    expect(simulationStore.getActionPlan(plan.id)).toMatchObject({ status: 'running' })
    const event = store.listWorldDomainEvents(world.id).find((item) => item.id === eventIds[0])
    expect(event).toMatchObject({
      type: 'world.interaction.requested',
      actorId: character.id,
      correlationId: plan.id,
      payload: expect.objectContaining({
        action: 'ambient-start',
        characterId: character.id,
        targetSlotId: decision.targetSlotId,
      }),
    })
  })

  it('completes expired plans, releases the slot and emits a return event', async () => {
    const { store, world, character, simulationStore } = await setup()
    const decision: AmbientDecision = {
      characterId: character.id,
      kind: 'inspect-work-area',
      source: 'role-routine',
      reason: '岗位巡检',
      priority: 16,
      interruptible: true,
      targetSlotId: 'work-engineering:slot-2',
      decisionKey: 'decision-2',
    }
    const queued = createAmbientActionPlan(decision, {
      worldId: world.id,
      now: '2026-08-22T10:00:00.000Z',
      idFactory: (scope) => scope.replaceAll(':', '-'),
    })
    const running = { ...queued, status: 'running' as const, startedAt: '2026-08-22T10:00:00.000Z' }
    simulationStore.saveActionPlan(running)
    simulationStore.saveReservations([{
      id: 'reservation-1',
      worldId: world.id,
      slotId: decision.targetSlotId,
      characterId: character.id,
      planId: running.id,
      status: 'reserved',
      priority: 16,
      reservedAt: running.startedAt,
      expiresAt: '2026-08-22T10:02:00.000Z',
      updatedAt: running.startedAt,
    }])
    const executor = new AmbientLifeExecutor({
      store,
      simulationStore,
      maximumDurationMs: 10_000,
      clock: () => '2026-08-22T10:00:20.000Z',
    })

    const eventIds = executor.completeDue(world.id)
    expect(eventIds).toHaveLength(1)
    expect(simulationStore.getActionPlan(running.id)).toMatchObject({ status: 'completed' })
    expect(simulationStore.listReservations(world.id)).toEqual([])
    const presence = simulationStore.getPresence(character.id)
    expect(presence?.activePlanId).toBeUndefined()
    expect(presence?.reservedSlotId).toBeUndefined()
    const event = store.listWorldDomainEvents(world.id).find((item) => item.id === eventIds[0])
    expect(event?.payload).toMatchObject({ action: 'ambient-complete', planId: running.id })
  })

  it('cleans an expired slot lease even when its plan is not yet due', async () => {
    const { store, world, character, simulationStore } = await setup()
    const decision: AmbientDecision = {
      characterId: character.id,
      kind: 'stay-at-post',
      source: 'role-routine',
      reason: '保持待命',
      priority: 8,
      interruptible: true,
      targetSlotId: 'work-engineering:slot-1',
      decisionKey: 'decision-stale-lease',
    }
    const plan = createAmbientActionPlan(decision, {
      worldId: world.id,
      now: '2026-08-22T10:00:00.000Z',
      idFactory: (scope) => scope.replaceAll(':', '-'),
    })
    simulationStore.saveActionPlan(plan)
    simulationStore.saveReservations([{
      id: 'stale-reservation',
      worldId: world.id,
      slotId: decision.targetSlotId,
      characterId: character.id,
      planId: plan.id,
      status: 'reserved',
      priority: 8,
      reservedAt: '2026-08-22T10:00:00.000Z',
      expiresAt: '2026-08-22T10:00:10.000Z',
      updatedAt: '2026-08-22T10:00:00.000Z',
    }])
    const executor = new AmbientLifeExecutor({
      store,
      simulationStore,
      maximumDurationMs: 300_000,
      clock: () => '2026-08-22T10:00:20.000Z',
    })

    expect(executor.completeDue(world.id)).toEqual([])
    expect(simulationStore.listReservations(world.id)).toEqual([])
    expect(simulationStore.getActionPlan(plan.id)).toMatchObject({ status: 'queued' })
  })
})
