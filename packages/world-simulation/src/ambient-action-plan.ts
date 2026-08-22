import type { JsonObject } from '@dsh-cyber/contracts'
import type {
  CharacterActionPlan,
  CharacterActionStep,
} from '@dsh-cyber/contracts/world-simulation'

import type { AmbientDecision } from './ambient-policy.js'

export interface AmbientPlanFactoryOptions {
  worldId: string
  now: string
  idFactory?: (scope: string) => string
  leaseMs?: number
}

const DEFAULT_LEASE_MS = 120_000

/**
 * Converts a deterministic ambient decision into the same durable action-plan
 * contract used by user tasks and conversations. Ambient behavior therefore
 * remains observable, interruptible and recoverable instead of becoming a
 * second, renderer-only source of truth.
 */
export function createAmbientActionPlan(
  decision: AmbientDecision,
  options: AmbientPlanFactoryOptions,
): CharacterActionPlan {
  const makeId = options.idFactory ?? deterministicId
  const planId = makeId(`ambient-plan:${options.worldId}:${decision.decisionKey}`)
  const createdAt = new Date(options.now).toISOString()
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  if (!Number.isInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 600_000) {
    throw new Error('Ambient action lease must be between 10 seconds and 10 minutes')
  }

  const steps: CharacterActionStep[] = []
  const append = (kind: CharacterActionStep['kind'], payload: JsonObject): void => {
    const sequence = steps.length + 1
    steps.push({
      id: makeId(`${planId}:step:${sequence}:${kind}`),
      planId,
      sequence,
      kind,
      payload,
      status: 'pending',
    })
  }

  append('reserve-slot', {
    slotId: decision.targetSlotId,
    leaseMs,
    decisionKey: decision.decisionKey,
  })
  append('navigate-to-slot', {
    slotId: decision.targetSlotId,
    source: decision.source,
  })

  if (decision.kind === 'consult-colleague' && decision.targetCharacterId !== undefined) {
    append('face-entity', { characterId: decision.targetCharacterId })
    append('wait', {
      purpose: 'peer-consultation-ready',
      targetCharacterId: decision.targetCharacterId,
      maximumMs: 30_000,
    })
  } else if (decision.kind === 'inspect-work-area') {
    append('play-activity', { activity: 'working', label: '岗位巡检' })
    append('wait', { purpose: 'role-routine', maximumMs: 20_000 })
  } else if (decision.kind === 'take-short-break') {
    append('play-activity', { activity: 'idle', label: '短暂休息' })
    append('wait', { purpose: 'short-break', maximumMs: 30_000 })
  } else {
    append('play-activity', { activity: 'idle', label: '岗位待命' })
  }

  append('release-slot', { slotId: decision.targetSlotId })

  return {
    id: planId,
    worldId: options.worldId,
    characterId: decision.characterId,
    source: decision.source,
    reason: decision.reason,
    priority: decision.priority,
    interruptible: true,
    status: 'queued',
    steps,
    createdAt,
  }
}

function deterministicId(value: string): string {
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ (code + index), 0x85ebca6b)
  }
  return `ambient-${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}
