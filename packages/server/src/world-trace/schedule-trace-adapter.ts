import type { ScheduledRunTraceFact, WorldTraceEntry } from '@dsh-cyber/contracts'

import { traceId, type WorldTraceAdapter } from './trace-adapter.js'

export class ScheduleTraceAdapter implements WorldTraceAdapter<'scheduled-run'> {
  readonly kind = 'scheduled-run' as const

  adapt({ value }: { kind: 'scheduled-run'; value: ScheduledRunTraceFact }): WorldTraceEntry[] {
    return [{
      id: traceId('scheduled-run', value.scheduleId, value.runId),
      worldId: value.worldId,
      category: 'schedule',
      status: value.status,
      summary: value.summary,
      ...(value.detail === undefined ? {} : { detail: value.detail }),
      ...(value.actorId === undefined ? {} : { actorId: value.actorId }),
      scheduleId: value.scheduleId,
      runId: value.runId,
      sourceKind: 'scheduled-run',
      sourceId: value.id,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }]
  }
}
