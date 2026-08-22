import type { CharacterActionPlan } from '@dsh-cyber/contracts/world-simulation'

import { createAmbientActionPlan } from './ambient-action-plan.js'
import {
  decideAmbientBehavior,
  type AmbientCharacterState,
  type AmbientDecision,
  type AmbientSlot,
} from './ambient-policy.js'

export interface AmbientWorldPolicy {
  enabled: boolean
  minimumIdleMs?: number
  minimumAmbientIntervalMs?: number
  socialCooldownMs?: number
  breakAfterMs?: number
  timeBucketMs?: number
  maximumPlansPerTick?: number
}

export interface AmbientCoordinationInput {
  worldId: string
  now: string
  characters: AmbientCharacterState[]
  slots: AmbientSlot[]
  policy: AmbientWorldPolicy
  idFactory?: (scope: string) => string
}

export interface AmbientCoordinationResult {
  decisions: AmbientDecision[]
  plans: CharacterActionPlan[]
  skippedCharacterIds: string[]
}

/**
 * Coordinates one deterministic ambient tick for the whole world.
 *
 * Characters are evaluated in stable identity order. Every selected slot is
 * reserved in-memory before the next character is evaluated, so the tick cannot
 * produce overlapping destinations. Real tasks and conversations are filtered by
 * decideAmbientBehavior before any plan is created.
 */
export function coordinateAmbientLife(input: AmbientCoordinationInput): AmbientCoordinationResult {
  const maximum = clampMaximum(input.policy.maximumPlansPerTick ?? 3)
  const workingSlots = input.slots.map((slot) => ({ ...slot }))
  const characters = [...input.characters]
    .filter((character) => character.worldId === input.worldId)
    .sort((left, right) => left.characterId.localeCompare(right.characterId))

  const decisions: AmbientDecision[] = []
  const plans: CharacterActionPlan[] = []
  const skippedCharacterIds: string[] = []
  const socialTargets = new Set<string>()

  for (const character of characters) {
    if (plans.length >= maximum) {
      skippedCharacterIds.push(character.characterId)
      continue
    }

    const decision = decideAmbientBehavior({
      now: input.now,
      character,
      colleagues: characters.filter((candidate) => !socialTargets.has(candidate.characterId)),
      slots: workingSlots,
      enabled: input.policy.enabled,
      ...(input.policy.minimumIdleMs === undefined ? {} : { minimumIdleMs: input.policy.minimumIdleMs }),
      ...(input.policy.minimumAmbientIntervalMs === undefined
        ? {}
        : { minimumAmbientIntervalMs: input.policy.minimumAmbientIntervalMs }),
      ...(input.policy.socialCooldownMs === undefined ? {} : { socialCooldownMs: input.policy.socialCooldownMs }),
      ...(input.policy.breakAfterMs === undefined ? {} : { breakAfterMs: input.policy.breakAfterMs }),
      ...(input.policy.timeBucketMs === undefined ? {} : { timeBucketMs: input.policy.timeBucketMs }),
    })
    if (decision === undefined) {
      skippedCharacterIds.push(character.characterId)
      continue
    }

    const selectedSlot = workingSlots.find((slot) => slot.id === decision.targetSlotId)
    if (selectedSlot === undefined || !isAvailable(selectedSlot, character.characterId)) {
      skippedCharacterIds.push(character.characterId)
      continue
    }

    selectedSlot.reservedBy = character.characterId
    if (decision.targetCharacterId !== undefined) socialTargets.add(decision.targetCharacterId)
    socialTargets.add(character.characterId)
    decisions.push(decision)
    plans.push(createAmbientActionPlan(decision, {
      worldId: input.worldId,
      now: input.now,
      ...(input.idFactory === undefined ? {} : { idFactory: input.idFactory }),
    }))
  }

  return { decisions, plans, skippedCharacterIds }
}

function isAvailable(slot: AmbientSlot, characterId: string): boolean {
  return (slot.occupiedBy === undefined || slot.occupiedBy === characterId)
    && (slot.reservedBy === undefined || slot.reservedBy === characterId)
}

function clampMaximum(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error('Ambient maximum plans per tick must be between 1 and 16')
  }
  return value
}
