import { describe, expect, it } from 'vitest'

import { DOMAIN_EVENT_TYPES, type DomainEvent, type DomainEventType } from '@dsh-cyber/contracts'

import { DomainEventTraceAdapter, TRACE_INVISIBLE_EVENT_TYPES } from '../src/world-trace/domain-event-trace-adapter.js'
import { TraceSanitizer } from '../src/world-trace/trace-sanitizer.js'

const adapter = new DomainEventTraceAdapter()
const context = { sanitizer: new TraceSanitizer(), actorName: () => '角色' }

function event(type: DomainEventType): DomainEvent {
  return {
    id: 'event-1',
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    sequence: 1,
    type,
    actorId: 'employee-1',
    actorKind: 'system',
    payload: {},
    createdAt: '2026-08-24T00:00:00.000Z',
  }
}

function rendersNothing(type: DomainEventType): boolean {
  return adapter.adapt({ kind: 'domain-event', value: event(type) }, context).length === 0
}

describe('trace domain-event filtering', () => {
  it('excludes exactly the types the adapter renders nothing for', () => {
    // The exclusion happens in SQL now, so a drift between this list and the
    // adapter would silently drop entries the trace is supposed to show.
    const actual = DOMAIN_EVENT_TYPES.filter(rendersNothing)
    expect([...TRACE_INVISIBLE_EVENT_TYPES].sort()).toEqual([...actual].sort())
  })

  it('still renders every type that is not excluded', () => {
    const excluded = new Set<string>(TRACE_INVISIBLE_EVENT_TYPES)
    for (const type of DOMAIN_EVENT_TYPES) {
      if (excluded.has(type)) continue
      expect(rendersNothing(type), type).toBe(false)
    }
  })

  it('drops roughly half of all event types before they are read', () => {
    // Worth stating: this is not a micro-optimisation, it is half the table.
    expect(TRACE_INVISIBLE_EVENT_TYPES.length).toBeGreaterThan(DOMAIN_EVENT_TYPES.length / 3)
  })
})
