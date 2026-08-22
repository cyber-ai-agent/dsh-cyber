import type { JsonObject, WorldRuntimeSnapshot } from '@dsh-cyber/contracts'
import type {
  CharacterActionPlan,
  CharacterActionSource,
  CharacterActionStep,
  WorldSlotReservation,
} from '@dsh-cyber/contracts/world-simulation'

import { CHARACTER_ACTION_PRIORITIES } from '@dsh-cyber/world-simulation'

export interface MaterializedWorldSimulation {
  plans: CharacterActionPlan[]
  reservations: WorldSlotReservation[]
}

export function materializeWorldSimulation(
  snapshot: WorldRuntimeSnapshot,
  now: string,
): MaterializedWorldSimulation {
  const plans: CharacterActionPlan[] = []
  const reservations: WorldSlotReservation[] = []
  const expiresAt = new Date(Date.parse(now) + 5 * 60_000).toISOString()

  for (const entity of snapshot.entities) {
    if (entity.kind !== 'agent') continue
    const planId = jsonString(entity.visualState, 'activePlanId')
    if (planId === undefined) continue
    const source = actionSource(entity.visualState)
    const reservedSlotId = jsonString(entity.visualState, 'reservedSlotId')
    const currentSlotId = jsonString(entity.visualState, 'currentSlotId')
    const steps = actionSteps(planId, entity.activity, reservedSlotId, currentSlotId)
    const priority = actionPriority(source)
    plans.push({
      id: planId,
      worldId: snapshot.worldId,
      characterId: entity.id,
      source,
      reason: entity.activityLabel,
      priority,
      interruptible: source === 'ambient' || source === 'role-routine' || source === 'system',
      status: 'running',
      steps,
      createdAt: entity.updatedAt,
      startedAt: entity.updatedAt,
      ...(jsonString(entity.visualState, 'activeSessionId') === undefined
        ? {}
        : { correlationId: jsonString(entity.visualState, 'activeSessionId')! }),
    })

    if (reservedSlotId !== undefined) {
      reservations.push({
        id: `${planId}:reservation:${reservedSlotId}`,
        worldId: snapshot.worldId,
        slotId: reservedSlotId,
        characterId: entity.id,
        planId,
        status: currentSlotId === reservedSlotId && entity.targetPosition === undefined ? 'occupied' : 'reserved',
        priority,
        reservedAt: entity.updatedAt,
        expiresAt,
        updatedAt: now,
      })
    }
  }

  return {
    plans: plans.sort((left, right) => left.id.localeCompare(right.id)),
    reservations: reservations.sort((left, right) => left.slotId.localeCompare(right.slotId)),
  }
}

function actionSteps(
  planId: string,
  activity: WorldRuntimeSnapshot['entities'][number]['activity'],
  reservedSlotId: string | undefined,
  currentSlotId: string | undefined,
): CharacterActionStep[] {
  const steps: CharacterActionStep[] = []
  if (reservedSlotId !== undefined) {
    steps.push({
      id: `${planId}:step-1`,
      planId,
      sequence: 1,
      kind: 'reserve-slot',
      payload: { slotId: reservedSlotId },
      status: 'completed',
    })
    steps.push({
      id: `${planId}:step-2`,
      planId,
      sequence: 2,
      kind: 'navigate-to-slot',
      payload: { slotId: reservedSlotId },
      status: currentSlotId === reservedSlotId ? 'completed' : 'running',
    })
  }
  steps.push({
    id: `${planId}:step-${steps.length + 1}`,
    planId,
    sequence: steps.length + 1,
    kind: 'play-activity',
    payload: { activity },
    status: reservedSlotId !== undefined && currentSlotId !== reservedSlotId ? 'pending' : 'running',
  })
  return steps
}

function actionSource(value: JsonObject): CharacterActionSource {
  const source = jsonString(value, 'actionSource')
  if (source === 'user' || source === 'task' || source === 'conversation'
    || source === 'role-routine' || source === 'ambient' || source === 'system') return source
  return 'system'
}

function actionPriority(source: CharacterActionSource): number {
  if (source === 'user') return CHARACTER_ACTION_PRIORITIES.user
  if (source === 'task') return CHARACTER_ACTION_PRIORITIES.task
  if (source === 'conversation') return CHARACTER_ACTION_PRIORITIES.conversation
  if (source === 'role-routine') return CHARACTER_ACTION_PRIORITIES.roleRoutine
  if (source === 'ambient') return CHARACTER_ACTION_PRIORITIES.ambient
  return CHARACTER_ACTION_PRIORITIES.roleRoutine
}

function jsonString(value: JsonObject, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' && field.trim() ? field : undefined
}
