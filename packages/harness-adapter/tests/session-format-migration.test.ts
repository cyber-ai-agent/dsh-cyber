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
