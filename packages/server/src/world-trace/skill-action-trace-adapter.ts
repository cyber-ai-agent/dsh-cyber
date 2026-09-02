import type { WorldTraceEntry, WorldTraceStatus } from '@dsh-cyber/contracts'
import type { CharacterSkillAction, SkillActionStatus } from '@dsh-cyber/contracts/skill-runtime'

import { traceId, type WorldTraceAdapter } from './trace-adapter.js'

export class SkillActionTraceAdapter implements WorldTraceAdapter<'skill-action'> {
  readonly kind = 'skill-action' as const

  adapt({ value }: { kind: 'skill-action'; value: CharacterSkillAction }): WorldTraceEntry[] {
    return [{
      id: traceId('skill-action', value.id),
      worldId: value.worldId,
      category: 'skill',
      status: skillStatus(value.status),
      summary: value.label,
      ...(value.detail.trim() ? { detail: value.detail } : {}),
      actorId: value.characterId,
      skillId: value.skillId,
      sourceKind: 'skill-action',
      sourceId: value.id,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }]
  }
}

function skillStatus(status: SkillActionStatus): WorldTraceStatus {
  if (status === 'scheduled') return 'pending'
  if (status === 'executed') return 'success'
  if (status === 'waiting-for-integration') return 'waiting'
  if (status === 'failed' || status === 'rejected') return 'failed'
  return 'waiting'
}
