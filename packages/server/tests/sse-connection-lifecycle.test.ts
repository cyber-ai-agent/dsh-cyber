import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { SseConnection } from '../src/http/sse.js'
import { RuntimeStreamHub } from '../src/streams/runtime-stream-hub.js'
import { WorldStreamHub } from '../src/streams/world-stream-hub.js'
import type { WorldRuntimeSnapshot } from '@dsh-cyber/contracts'

class ResponseStub extends EventEmitter {
  writableEnded = false
  destroyed = false
  writableLength = 0
  blocked = true
  chunks: string[] = []
  writeHead(): this { return this }
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    if (this.blocked) this.writableLength += Buffer.byteLength(chunk)
    return !this.blocked
  }
  end(): this { this.writableEnded = true; return this }
  destroy(): this { this.destroyed = true; this.emit('close'); return this }
  drain(): void { this.writableLength = 0; this.blocked = false; this.emit('drain') }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('destroys a stalled transport instead of merely asking it to flush end()', () => {
  const response = new ResponseStub(); const closed = vi.fn()
  const connection = new SseConnection(response as unknown as ServerResponse, closed, { maxBufferedBytes: 256 })
  connection.send('runtime', { text: 'x'.repeat(100) })
  connection.send('runtime', { text: 'y'.repeat(100) })
  expect(connection.closed).toBe(true)
  expect(response.destroyed).toBe(true)
  expect(response.listenerCount('drain')).toBe(0)
  expect(closed).toHaveBeenCalledOnce()
})

it('expires a stalled writer even without another event or heartbeat', () => {
  vi.useFakeTimers()
  const response = new ResponseStub(); const closed = vi.fn()
  const connection = new SseConnection(response as unknown as ServerResponse, closed)
  connection.send('runtime', { text: 'waiting' })
  vi.advanceTimersByTime(15_000)
  expect(response.destroyed).toBe(true)
  expect(closed).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels the stall timer on drain, flushes exactly once in order and allows later writes', () => {
  vi.useFakeTimers()
  const response = new ResponseStub(); const closed = vi.fn()
  const connection = new SseConnection(response as unknown as ServerResponse, closed)
  connection.send('one', { value: 1 }); connection.send('two', { value: 2 })
  expect(response.chunks).toHaveLength(1)
  vi.advanceTimersByTime(14_999); response.drain()
  expect(response.chunks).toHaveLength(2)
  expect(response.chunks[1]).toContain('event: two')
  vi.advanceTimersByTime(30_000)
  expect(connection.closed).toBe(false)
  connection.send('three', {}); expect(response.chunks).toHaveLength(3)
  connection.close(); expect(closed).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('owns response errors and releases every transport listener exactly once', () => {
  const response = new ResponseStub(); const closed = vi.fn()
  const connection = new SseConnection(response as unknown as ServerResponse, closed)
  connection.send('runtime', {})
  expect(() => response.emit('error', new Error('socket failed'))).not.toThrow()
  connection.close(); response.emit('close')
  expect(closed).toHaveBeenCalledOnce()
  expect(response.eventNames()).toEqual([])
})

it('removes the drain continuation when a connection is closed early', () => {
  const response = new ResponseStub(); const closed = vi.fn()
  const connection = new SseConnection(response as unknown as ServerResponse, closed)
  connection.send('one', {}); connection.send('two', {})
  connection.close(); response.drain()
  expect(response.chunks).toHaveLength(1)
  expect(response.listenerCount('drain')).toBe(0)
  expect(closed).toHaveBeenCalledOnce()
})


it.each(['runtime', 'world'] as const)('releases request and response listeners when the %s hub closes', (kind) => {
  vi.useFakeTimers()
  const hub = kind === 'runtime' ? new RuntimeStreamHub() : new WorldStreamHub()
  const request = Object.assign(new EventEmitter(), { headers: {} }) as IncomingMessage
  const response = new ResponseStub()
  const nodeResponse = response as unknown as ServerResponse
  const snapshot = { sequence: 0 } as WorldRuntimeSnapshot
  if (hub instanceof WorldStreamHub) hub.connect('world', request, nodeResponse, snapshot, '0')
  else hub.connect('world', request, nodeResponse)
  expect(hub.clientCount).toBe(1)
  expect(request.listenerCount('aborted')).toBe(1)
  hub.close()
  expect(response.destroyed).toBe(true)
  expect(request.listenerCount('close')).toBe(0)
  expect(request.listenerCount('aborted')).toBe(0)
  expect(response.eventNames()).toEqual([])
  expect(hub.clientCount).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects invalid timeout options before attaching transport listeners', () => {
  for (const drainTimeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    const response = new ResponseStub()
    expect(() => new SseConnection(response as unknown as ServerResponse, () => {}, { drainTimeoutMs })).toThrow(/timer-safe/)
    expect(response.eventNames()).toEqual([])
  }
})

it('does not turn cleanup failure into a publisher failure', () => {
  const response = new ResponseStub()
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const connection = new SseConnection(response as unknown as ServerResponse, () => { throw new Error('private cleanup error') })
  expect(() => connection.close()).not.toThrow()
  expect(log).toHaveBeenCalledWith('[dsh-cyber] SSE subscriber cleanup failed')
  expect(response.eventNames()).toEqual([])
})
