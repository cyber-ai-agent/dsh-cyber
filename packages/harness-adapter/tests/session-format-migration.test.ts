import { describe, expect, it } from 'vitest'

import {
  SessionFormatEventCollector,
  type SessionFormatEvent,
  type SessionFormatHeader,
} from '@deepseek-ai/dsh-session-format'
import {
  restoreReleasedV3Artifact,
  sessionFormatV2ToV3,
} from '@deepseek-ai/dsh-session-format-v2-to-v3'
import {
  createSessionFormatV3ToV4,
  RELEASED_V3_EVENT_TYPES,
  restoreReleasedV4Artifact,
} from '@deepseek-ai/dsh-session-format-v3-to-v4'

const sourceHeader: SessionFormatHeader = {
  version: 2,
  id: 'dsh-cyber-migration-fixture',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'code',
}

function request(system?: string): Record<string, unknown> {
  return {
    header: {
      config: { provider: 'mock', model: 'mock' },
      ...(system === undefined ? {} : { system }),
    },
    reason: 'initial',
  }
}

function user(id = 'user'): Record<string, unknown> {
  return {
    role: 'user',
    id,
    source: { kind: 'user' },
    content: [{ type: 'text', text: id }],
  }
}

function event(
  type: string,
  data: SessionFormatEvent['data'],
  surfaceOp?: SessionFormatEvent['surfaceOp'],
): SessionFormatEvent {
  return {
    type,
    seq: 0,
    time: 42,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  }
}

function dense(events: readonly SessionFormatEvent[]): SessionFormatEvent[] {
  return events.map((value, seq) => ({ ...value, seq }))
}

function migrate(events: readonly SessionFormatEvent[]) {
  const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
  const stage = sessionFormatV2ToV3.createStage({
    sourceHeader,
    targetHeader,
    sourceInheritedEventCount: 0,
    sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const value of dense(events)) stage.transformEvent(value, collector)
  const artifact = {
    header: targetHeader,
    inheritedEventCount: stage.finish(collector),
    events: collector.values,
  }
  return restoreReleasedV3Artifact(artifact, new Set())
}

function migrateToV4(events: readonly SessionFormatEvent[]) {
  const v3 = migrate(events)
  const source = structuredClone(v3)
  // DSH Cyber's isolated fixtures have no child sessions. The V4 edge
  // requires this fact explicitly; an absent child catalog is not evidence.
  const migration = createSessionFormatV3ToV4([])
  const targetHeader = migration.migrateHeader(v3.header)
  const stage = migration.createStage({
    sourceHeader: v3.header,
    targetHeader,
    sourceInheritedEventCount: v3.inheritedEventCount,
    sourceKind: 'decoded',
  })
  const collector = new SessionFormatEventCollector()
  for (const value of v3.events) stage.transformEvent(value, collector)
  const artifact = restoreReleasedV4Artifact({
    header: targetHeader,
    inheritedEventCount: stage.finish(collector),
    events: collector.values,
  }, RELEASED_V3_EVENT_TYPES)
  return { source, v3, artifact }
}

describe('DeepSeek Harness V2 to V3 session migration', () => {
  it('promotes the stored system prompt while preserving message chronology and content', () => {
    const source = [
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      event('user/message', user(), 'append'),
      event('request/header', request('legacy system prompt')),
    ]

    const target = migrate(source)

    expect(target.header).toMatchObject({ version: 3, agentPreset: 'ptc' })
    expect(target.inheritedEventCount).toBe(0)
    expect(target.events.map((value) => value.type)).toEqual([
      'turn/start',
      'step/start',
      'system/message',
      'user/message',
      'system/message',
      'request/header',
    ])
    expect(target.events.filter((value) => value.type === 'system/message').at(-1)?.data).toMatchObject({
      message: {
        role: 'system',
        content: [{ type: 'text', text: 'legacy system prompt' }],
      },
    })
    const migratedHeader = target.events.find((value) => value.type === 'request/header')
    expect((migratedHeader?.data as Record<string, unknown>).header).not.toHaveProperty('system')
    expect(target.events.find((value) => value.type === 'user/message')?.data).toEqual(source[2]?.data)
  })

  it('keeps the original V2 source object available for retry-safe preparation', () => {
    const source = dense([
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      event('request/header', request('retry-safe')),
    ])
    const snapshot = structuredClone(source)

    migrate(source)

    expect(source).toEqual(snapshot)
  })
})

describe('DeepSeek Harness V3 to V4 session migration', () => {
  it('advances an isolated legacy session without changing its V3 source events', () => {
    const { source, v3, artifact } = migrateToV4([
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      event('user/message', user('preserved-request'), 'append'),
      event('request/header', request('preserved system prompt')),
    ])
    expect(source.header.version).toBe(3)
    expect(v3).toEqual(source)
    expect(artifact.header.version).toBe(4)
    expect(artifact.events.find((value) => value.type === 'user/message')?.data).toMatchObject({ id: 'preserved-request' })
    expect(source.events.find((value) => value.type === 'user/message')?.data).toMatchObject({ id: 'preserved-request' })
  })
})
