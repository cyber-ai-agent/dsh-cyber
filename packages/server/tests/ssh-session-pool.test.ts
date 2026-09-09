import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeConnectLog, fakeEndLog, fakeState } = vi.hoisted(() => ({
  fakeConnectLog: [] as Array<Record<string, unknown>>,
  fakeEndLog: [] as string[],
  fakeState: {
    failNextConnect: false,
    activeClient: undefined as { failTransport(error: Error): void } | undefined,
  },
}))

type Handler = (...args: any[]) => void

const { FakeStreamClass, FakeClientClass } = vi.hoisted(() => {
  class FakeChannel {
    handlers: Array<(...args: any[]) => void> = []
    on(_event: string, fn: (...args: any[]) => void) { this.handlers.push(fn); return this }
    once(event: string, fn: (...args: any[]) => void) { return this.on(event, fn) }
    setEncoding() { return this }
    emit(...args: unknown[]) { for (const fn of this.handlers.splice(0)) fn(...args) }
  }
  class FakeStream {
    #closed = false
    stdout = new FakeChannel()
    stderr = new FakeChannel()
    constructor(public command: string) {}
    setEncoding() { return this }
    on(event: string, fn: (...args: any[]) => void) {
      if (event === 'data') this.stdout.on(event, fn)
      return this
    }
    once(event: string, fn: (...args: any[]) => void) {
      if (event === 'data') this.stdout.once(event, fn)
      if (event === 'close') this.#onClose = fn
      if (event === 'error') this.#onError = fn
      return this
    }
    #onClose?: (code: number | null) => void
    #onError?: (error: Error) => void
    finish() {
      if (this.#closed) return
      this.#closed = true
      queueMicrotask(() => { this.stdout.emit(`out:${this.command}`) })
      queueMicrotask(() => { this.#onClose?.(0) })
    }
    fail(error: Error) {
      this.#closed = true
      queueMicrotask(() => { this.#onError?.(error) })
    }
    close() { this.finish() }
  }
  class FakeClient {
    #listeners = new Map<string, Array<(...args: any[]) => void>>()
    #ended = false
    constructor() { fakeState.activeClient = this }
    connect(options: Record<string, unknown>) {
      fakeConnectLog.push(options)
      if (fakeState.failNextConnect) {
        fakeState.failNextConnect = false
        queueMicrotask(() => this.#emit('error', new Error('connect ECONNREFUSED')))
      } else {
        queueMicrotask(() => this.#emit('ready'))
      }
      return this
    }
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.#listeners.get(event) ?? []
      list.push(fn)
      this.#listeners.set(event, list)
      return this
    }
    once(event: string, fn: (...args: any[]) => void) {
      const wrapper = (...args: unknown[]): void => { this.off(event, wrapper); fn(...args) }
      return this.on(event, wrapper)
    }
    off(event: string, fn: (...args: any[]) => void) {
      const list = this.#listeners.get(event) ?? []
      this.#listeners.set(event, list.filter((item) => item !== fn))
      return this
    }
    exec(command: string, _opts: unknown, callback: (error: Error | null | undefined, stream?: unknown) => void) {
      if (this.#ended) { callback(new Error('client destroyed')); return this }
      const stream = new FakeStream(command)
      queueMicrotask(() => { callback(undefined, stream); stream.finish() })
      return this
    }
    end() {
      if (this.#ended) return this
      this.#ended = true
      fakeEndLog.push('end')
      return this
    }
    failTransport(error: Error) { this.#emit('error', error) }
    #emit(event: string, ...payload: unknown[]) {
      for (const fn of [...(this.#listeners.get(event) ?? [])]) fn(...payload)
    }
  }
  return { FakeStreamClass: FakeStream, FakeClientClass: FakeClient }
})

vi.mock('ssh2', () => ({ Client: FakeClientClass }))
import { SshDeviceCredential, SshSessionPool } from '../src/integrations/ssh-client.js'

function device(password = 'pw-1'): SshDeviceCredential {
  return { host: '10.0.0.10', port: 22, username: 'root', password }
}

beforeEach(() => { fakeConnectLog.length = 0; fakeEndLog.length = 0; fakeState.failNextConnect = false; fakeState.activeClient = undefined })
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

describe('SshSessionPool', () => {
  it('reuses one transport across sequential commands', async () => {
    const pool = new SshSessionPool({ idleMs: 10_000 })
    const first = await pool.exec(device(), 'echo 1')
    const second = await pool.exec(device(), 'echo 2')
    expect(first.stdout).toContain('out:echo 1')
    expect(second.stdout).toContain('out:echo 2')
    expect(fakeConnectLog).toHaveLength(1)
    expect(pool.size).toBe(1)
    await pool.close()
    expect(fakeEndLog.length).toBeGreaterThanOrEqual(1)
  })

  it('reconnects on a fresh transport after invalidation', async () => {
    const pool = new SshSessionPool({ idleMs: 10_000 })
    await pool.exec(device('a'), 'x')
    await pool.invalidate(device('a'))
    expect(pool.size).toBe(0)
    await pool.exec(device('a'), 'y')
    expect(fakeConnectLog).toHaveLength(2)
    await pool.close()
  })

  it('fingerprint changes when a credential is edited but is stable otherwise', () => {
    const a = SshSessionPool.fingerprint(device('pw-1'))
    expect(SshSessionPool.fingerprint(device('pw-1'))).toBe(a)
    expect(SshSessionPool.fingerprint(device('pw-2'))).not.toBe(a)
  })

  it('does not keep plaintext credentials in the fingerprint', () => {
    const fingerprint = SshSessionPool.fingerprint({ host: '10.0.0.10', port: 22, username: 'root', password: 'super-secret' })
    expect(fingerprint).not.toContain('super-secret')
    expect(fingerprint).not.toContain('10.0.0.10')
  })

  it('maps a refused connect to SshError unreachable and drops the entry', async () => {
    fakeState.failNextConnect = true
    const pool = new SshSessionPool()
    await expect(pool.exec(device(), 'x')).rejects.toMatchObject({ kind: 'unreachable' })
    expect(pool.size).toBe(0)
    await pool.close()
  })

  it('evicts idle sessions after the idle window', async () => {
    vi.useFakeTimers()
    const pool = new SshSessionPool({ idleMs: 1_000 })
    await pool.exec(device('a'), 'x')
    expect(pool.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(pool.size).toBe(0)
    vi.useRealTimers()
  })

  it('serializes concurrent commands on one transport', async () => {
    const pool = new SshSessionPool({ idleMs: 10_000 })
    const results = await Promise.all([pool.exec(device(), 'first'), pool.exec(device(), 'second')])
    expect(results).toHaveLength(2)
    expect(fakeConnectLog).toHaveLength(1)
    expect(pool.size).toBe(1)
    await pool.close()
  })

  it('handles a transport error after ready and reconnects without an unhandled error', async () => {
    const pool = new SshSessionPool({ idleMs: 10_000 })
    await pool.exec(device(), 'before-disconnect')
    const firstClient = fakeState.activeClient
    expect(firstClient).toBeDefined()

    // A real ssh2 Client emits `error` when an established socket dies. The
    // pool must consume it, reject any waiters and remove the dead entry.
    firstClient!.failTransport(new Error('socket closed'))
    expect(pool.size).toBe(0)

    const result = await pool.exec(device(), 'after-disconnect')
    expect(result.stdout).toContain('out:after-disconnect')
    expect(fakeConnectLog).toHaveLength(2)
    await pool.close()
  })

  it('rejects commands after close', async () => {
    const pool = new SshSessionPool()
    await pool.close()
    await expect(pool.exec(device(), 'x')).rejects.toThrow('SSH session pool is closed')
  })
})
