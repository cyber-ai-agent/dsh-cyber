import type { JsonObject } from '@dsh-cyber/contracts'
import type {
  CharacterActionPlan,
  CharacterActionPlanStatus,
  CharacterActionSource,
  CharacterActionStep,
  CharacterActionStepKind,
  WorldSlotDefinition,
} from '@dsh-cyber/contracts/world-simulation'

export const CHARACTER_ACTION_PRIORITIES = {
  safety: 100,
  user: 90,
  task: 80,
  conversation: 70,
  roleRoutine: 50,
  social: 30,
  ambient: 10,
} as const

export interface CreateCharacterActionPlanInput {
  id: string
  worldId: string
  characterId: string
  source: CharacterActionSource
  reason: string
  priority: number
  interruptible: boolean
  now: string
  targetSlot?: WorldSlotDefinition
  activity?: string
  objectId?: string
  targetCharacterId?: string
  causationId?: string
  correlationId?: string
}

export function createCharacterActionPlan(input: CreateCharacterActionPlanInput): CharacterActionPlan {
  const steps: Array<{ kind: CharacterActionStepKind; payload: JsonObject }> = []
  if (input.targetSlot !== undefined) {
    steps.push({
      kind: 'reserve-slot',
      payload: { slotId: input.targetSlot.id, zoneId: input.targetSlot.zoneId },
    })
    steps.push({
      kind: 'navigate-to-slot',
      payload: {
        slotId: input.targetSlot.id,
        x: input.targetSlot.position.x,
        y: input.targetSlot.position.y,
        facing: input.targetSlot.facing,
      },
    })
    steps.push({
      kind: 'set-pose',
      payload: { posture: input.targetSlot.posture, slotId: input.targetSlot.id },
    })
  }
  if (input.targetCharacterId !== undefined) {
    steps.push({ kind: 'face-entity', payload: { characterId: input.targetCharacterId } })
  }
  if (input.objectId !== undefined) {
    steps.push({ kind: 'face-object', payload: { objectId: input.objectId } })
    steps.push({ kind: 'use-object', payload: { objectId: input.objectId } })
  }
  if (input.activity !== undefined) {
    steps.push({ kind: 'play-activity', payload: { activity: input.activity } })
  }

  const normalizedSteps = steps.map((step, index): CharacterActionStep => ({
    id: `${input.id}:step-${index + 1}`,
    planId: input.id,
    sequence: index + 1,
    kind: step.kind,
    payload: step.payload,
    status: 'pending',
  }))

  return {
    id: input.id,
    worldId: input.worldId,
    characterId: input.characterId,
    source: input.source,
    reason: input.reason,
    priority: input.priority,
    interruptible: input.interruptible,
    status: 'queued',
    steps: normalizedSteps,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    createdAt: input.now,
  }
}

export function canInterruptActionPlan(
  current: Pick<CharacterActionPlan, 'priority' | 'interruptible' | 'status'> | undefined,
  incoming: Pick<CharacterActionPlan, 'priority'>,
): boolean {
  if (current === undefined) return true
  if (current.status === 'completed' || current.status === 'cancelled' || current.status === 'failed') return true
  return current.interruptible && incoming.priority > current.priority
}

export function transitionActionPlan(
  plan: CharacterActionPlan,
  status: CharacterActionPlanStatus,
  now: string,
): CharacterActionPlan {
  if (!validPlanTransition(plan.status, status)) {
    throw new Error(`Invalid character action plan transition: ${plan.status} -> ${status}`)
  }
  return {
    ...plan,
    status,
    ...(status === 'running' && plan.startedAt === undefined ? { startedAt: now } : {}),
    ...(status === 'completed' || status === 'cancelled' || status === 'failed'
      ? { completedAt: now }
      : {}),
  }
}

export function startNextActionStep(plan: CharacterActionPlan, now: string): CharacterActionPlan {
  const next = plan.steps.find((step) => step.status === 'pending')
  if (next === undefined) return transitionActionPlan(plan, 'completed', now)
  return {
    ...plan,
    status: plan.status === 'queued' ? 'running' : plan.status,
    ...(plan.startedAt === undefined ? { startedAt: now } : {}),
    steps: plan.steps.map((step) => step.id === next.id
      ? { ...step, status: 'running' as const, startedAt: now }
      : step),
  }
}

export function completeActionStep(plan: CharacterActionPlan, stepId: string, now: string): CharacterActionPlan {
  const target = plan.steps.find((step) => step.id === stepId)
  if (target === undefined) throw new Error(`Character action step not found: ${stepId}`)
  if (target.status !== 'running') throw new Error(`Character action step is not running: ${stepId}`)
  const steps = plan.steps.map((step) => step.id === stepId
    ? { ...step, status: 'completed' as const, completedAt: now }
    : step)
  const completed = steps.every((step) => step.status === 'completed' || step.status === 'cancelled')
  return {
    ...plan,
    steps,
    ...(completed ? { status: 'completed' as const, completedAt: now } : {}),
  }
}

function validPlanTransition(from: CharacterActionPlanStatus, to: CharacterActionPlanStatus): boolean {
  if (from === to) return true
  if (from === 'queued') return to === 'running' || to === 'cancelled' || to === 'failed'
  if (from === 'running') return to === 'completed' || to === 'cancelled' || to === 'failed'
  return false
}
