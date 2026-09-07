import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeWorldLive, subscribeWorldLiveRefresh } from '../src/world-live-client.js'

class Source {
  static instances: Source[] = []
  listeners = new Map<string, Array<(event: Event) => void>>()
  constructor(readonly url: string) { Source.instances.push(this) }
  addEventListener(name: string, callback: (event: Event) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback])
  }
  close(): void {}
  emit(name: string): void { for (const callback of this.listeners.get(name) ?? []) callback(new Event(name)) }
}
const stops: Array<() => void> = []
let id = 0
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('EventSource', Source); Source.instances = [] })
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function subscribe(refresh: () => void | Promise<void>): Source {
  stops.push(subscribeWorldLiveRefresh(`refresh-${++id}`, 'world-task', refresh))
  return Source.instances.at(-1)!
}

it('coalesces a readiness signal and a burst of facts into one refresh', async () => {
  const refresh = vi.fn(); const source = subscribe(refresh)
  source.emit('ready'); for (let i = 0; i < 100; i += 1) source.emit('world-task')
  await vi.advanceTimersByTimeAsync(50)
  expect(refresh).toHaveBeenCalledOnce()
  source.emit('world-state'); source.emit('runtime'); await vi.advanceTimersByTimeAsync(50)
  expect(refresh).toHaveBeenCalledOnce()
  source.emit('ready'); await vi.advanceTimersByTimeAsync(50)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('retains one trailing invalidation while a refresh is pending, without parallel work', async () => {
  let resolve!: () => void
  const pending = new Promise<void>((done) => { resolve = done })
  const refresh = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined)
  const source = subscribe(refresh)
  source.emit('world-task'); await vi.advanceTimersByTimeAsync(50)
  for (let i = 0; i < 100; i += 1) source.emit('world-task')
  await vi.advanceTimersByTimeAsync(1_000); expect(refresh).toHaveBeenCalledOnce()
  resolve(); await vi.advanceTimersByTimeAsync(50)
  expect(refresh).toHaveBeenCalledTimes(2)
})

it('does not launch a queued refresh after unsubscribe', async () => {
  const refresh = vi.fn(); const source = subscribe(refresh)
  source.emit('ready'); stops.pop()!(); await vi.advanceTimersByTimeAsync(100)
  expect(refresh).not.toHaveBeenCalled()
})

it('does not launch trailing work after disposal during a pending request', async () => {
  let resolve!: () => void
  const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done }))
  const source = subscribe(refresh)
  source.emit('ready'); await vi.advanceTimersByTimeAsync(50)
  source.emit('world-task'); stops.pop()!(); resolve(); await vi.advanceTimersByTimeAsync(100)
  expect(refresh).toHaveBeenCalledOnce()
})

it('handles async subscriber failures without rejecting or interrupting healthy subscribers', async () => {
  const error = new Error('async panel failure'); const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  stops.push(subscribeWorldLive('async-owner', 'runtime', async () => { throw error }))
  const healthy = vi.fn(); stops.push(subscribeWorldLive('async-owner', 'runtime', healthy))
  Source.instances.at(-1)!.emit('runtime'); await Promise.resolve(); await Promise.resolve()
  expect(healthy).toHaveBeenCalledOnce(); expect(logged).toHaveBeenCalledWith('[dsh-cyber] world live subscriber failed', error)
})

it('defers new subscribers until the next event and skips subscribers removed during dispatch', () => {
  const late = vi.fn(); const removed = vi.fn(); let stopRemoved = () => {}
  stops.push(subscribeWorldLive('dispatch-owners', 'runtime', () => { stopRemoved(); stops.push(subscribeWorldLive('dispatch-owners', 'runtime', late)) }))
  stopRemoved = subscribeWorldLive('dispatch-owners', 'runtime', removed); stops.push(stopRemoved)
  const source = Source.instances.at(-1)!
  source.emit('runtime'); expect(late).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled()
  source.emit('runtime'); expect(late).toHaveBeenCalledOnce()
})


it('coalesces task and artifact publication into one owned refresh with a single ready subscription', async () => {
  const refresh = vi.fn()
  stops.push(subscribeWorldLiveRefresh('task-with-artifacts', ['world-task', 'world-artifact', 'world-task'], refresh))
  const source = Source.instances.at(-1)!
  source.emit('ready'); source.emit('world-task'); source.emit('world-artifact')
  await vi.advanceTimersByTimeAsync(50)
  expect(refresh).toHaveBeenCalledOnce()
  stops.pop()!(); source.emit('world-artifact'); await vi.advanceTimersByTimeAsync(100)
  expect(refresh).toHaveBeenCalledOnce()
})
