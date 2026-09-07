import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { subscribeWorldLive } from '../src/world-live-client.js'

/** Minimal stand-in: the real one would open a network connection. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const bucket = this.listeners.get(type) ?? new Set()
    this.listeners.set(type, bucket)
    bucket.add(listener)
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close(): void {
    this.closed = true
  }
}

const EVENT_NAMES = [
  'error',
  'ready',
  'conversation-control',
  'runtime',
  'trace',
  'world-cue',
  'world-decision',
  'world-artifact',
  'world-knowledge',
  'world-runtime',
  'world-state',
] as const

beforeEach(() => {
  FakeEventSource.instances = []
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { EventSource?: unknown }).EventSource
})

describe('subscribeWorldLive', () => {
  it('subscribes to every declared event name without throwing', () => {
    // Adding `world-decision` to the event union but not to the client's
    // listener registry threw on the first subscribe and blanked the whole
    // application. Nothing caught it: web tests rendered static markup, so no
    // effect ever ran and no subscription was ever made.
    const unsubscribes = EVENT_NAMES.map((name, index) =>
      expect(() => subscribeWorldLive(`world-${index}`, name, () => {})).not.toThrow())
    expect(unsubscribes).toHaveLength(EVENT_NAMES.length)
  })

  it('delivers an event to the listener that asked for it', () => {
    const seen: unknown[] = []
    const stop = subscribeWorldLive('world-a', 'world-decision', (event) => {
      seen.push(JSON.parse((event as MessageEvent<string>).data))
    })
    const source = FakeEventSource.instances.at(-1)!
    source.emit('world-decision', { worldId: 'world-a', requestId: 'request-1' })
    expect(seen).toEqual([{ worldId: 'world-a', requestId: 'request-1' }])
    stop()
  })

  it('isolates one subscriber failure from the other listeners on the shared stream', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: unknown[] = []
    const stopBroken = subscribeWorldLive('world-isolated', 'runtime', () => {
      throw new Error('panel failed')
    })
    const stopHealthy = subscribeWorldLive('world-isolated', 'runtime', (event) => {
      seen.push(JSON.parse((event as MessageEvent<string>).data))
    })
    const source = FakeEventSource.instances.at(-1)!
    expect(() => source.emit('runtime', { worldId: 'world-isolated', sequence: 1 })).not.toThrow()
    expect(seen).toEqual([{ worldId: 'world-isolated', sequence: 1 }])
    expect(errors).toHaveBeenCalledOnce()
    stopBroken()
    stopHealthy()
    errors.mockRestore()
  })

  it('does not deliver one event kind to another kind of listener', () => {
    const decisions: unknown[] = []
    const stop = subscribeWorldLive('world-b', 'world-decision', () => decisions.push(1))
    const source = FakeEventSource.instances.at(-1)!
    source.emit('world-state', { worldId: 'world-b' })
    expect(decisions).toEqual([])
    stop()
  })

  it('shares one connection across the listeners of a world', () => {
    const stopA = subscribeWorldLive('world-c', 'runtime', () => {})
    const stopB = subscribeWorldLive('world-c', 'world-decision', () => {})
    // The SSE connection is an origin-wide resource; a panel per listener would
    // exhaust the browser's connection pool.
    expect(FakeEventSource.instances.filter((item) => item.url.includes('world-c'))).toHaveLength(1)
    stopA()
    stopB()
  })

  it('keeps the shared connection through a short unmount/remount gap', () => {
    vi.useFakeTimers()
    const stop = subscribeWorldLive('world-grace', 'runtime', () => {})
    const source = FakeEventSource.instances.at(-1)!
    stop()

    vi.advanceTimersByTime(249)
    const remountedStop = subscribeWorldLive('world-grace', 'trace', () => {})
    expect(FakeEventSource.instances.filter((item) => item.url.includes('world-grace'))).toHaveLength(1)
    expect(source.closed).toBe(false)

    remountedStop()
    vi.advanceTimersByTime(250)
    expect(source.closed).toBe(true)
  })
})
