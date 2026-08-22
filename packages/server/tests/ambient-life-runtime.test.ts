import { describe, expect, it } from 'vitest'

import type { AmbientLifeTickResult } from '../src/services/role-aware-ambient-life-service.js'
import { AmbientLifeRuntime } from '../src/services/ambient-life-runtime.js'

function result(worldId = 'world-1'): AmbientLifeTickResult {
  return {
    worldId,
    generatedAt: '2026-08-22T12:00:00.000Z',
    decisions: [],
    plans: [],
    skippedCharacterIds: [],
    persistedPlanIds: [],
  }
}

describe('AmbientLifeRuntime', () => {
  it('completes old work before planning, emits new events and publishes once', async () => {
    const calls: string[] = []
    const runtime = new AmbientLifeRuntime({
      clock: () => '2026-08-22T12:00:20.000Z',
      executor: {
        completeDue(worldId, now) {
          calls.push(`complete:${worldId}:${now}`)
          return ['completed-event']
        },
        start(value) {
          calls.push(`start:${value.worldId}`)
          return ['started-event']
        },
      },
      service: {
        async tick(worldId) {
          calls.push(`plan:${worldId}`)
          return result(worldId)
        },
      },
      publish(worldId) {
        calls.push(`publish:${worldId}`)
      },
    })

    await expect(runtime.tick('world-1')).resolves.toEqual(result())
    expect(calls).toEqual([
      'complete:world-1:2026-08-22T12:00:20.000Z',
      'plan:world-1',
      'start:world-1',
      'publish:world-1',
    ])
  })

  it('does not publish when a tick creates no semantic world event', async () => {
    const published: string[] = []
    const runtime = new AmbientLifeRuntime({
      executor: {
        completeDue: () => [],
        start: () => [],
      },
      service: {
        async tick(worldId) {
          return result(worldId)
        },
      },
      publish: (worldId) => published.push(worldId),
    })

    await runtime.tick('world-2')
    expect(published).toEqual([])
  })
})
