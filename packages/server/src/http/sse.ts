import type { ServerResponse } from 'node:http'

/**
 * A live view can always recover from the latest snapshot after reconnecting.
 * That makes disconnecting a client which cannot keep up safer than allowing
 * Node's writable buffer to grow without a bound.
 */
export const DEFAULT_SSE_MAX_BUFFERED_BYTES = 64 * 1024
export const DEFAULT_SSE_DRAIN_TIMEOUT_MS = 15_000

export interface SseConnectionOptions {
  maxBufferedBytes?: number
  /** Maximum time a response may remain backpressured without draining. */
  drainTimeoutMs?: number
}

/**
 * Owns the small amount of buffering required by a ServerResponse while an
 * SSE peer is applying backpressure. A failed or slow peer is closed in
 * isolation; callers publishing to other peers are never interrupted.
 */
export class SseConnection {
  readonly #response: ServerResponse
  readonly #maxBufferedBytes: number
  readonly #onClose: () => void
  readonly #drainTimeoutMs: number
  #drainTimer: NodeJS.Timeout | undefined
  readonly #onDrain = () => this.#drain()
  readonly #onResponseClose = () => this.close()
  readonly #onResponseError = () => this.#finish(true)
  #queued: string[] = []
  #queuedBytes = 0
  #waitingDrain = false
  #closed = false

  constructor(response: ServerResponse, onClose: () => void, options: SseConnectionOptions = {}) {
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_SSE_MAX_BUFFERED_BYTES
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
      throw new Error('SSE maximum buffered bytes must be a positive safe integer')
    }
    const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_SSE_DRAIN_TIMEOUT_MS
    if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0 || drainTimeoutMs > 2_147_483_647) {
      throw new Error('SSE drain timeout must be a positive timer-safe integer')
    }
    this.#drainTimeoutMs = drainTimeoutMs
    this.#response = response
    this.#maxBufferedBytes = maxBufferedBytes
    this.#onClose = onClose
    response.once?.('close', this.#onResponseClose)
    response.once?.('error', this.#onResponseError)
  }

  get closed(): boolean {
    return this.#closed || this.#response.writableEnded || this.#response.destroyed
  }

  send(event: string, value: unknown, id?: string): boolean {
    if (this.closed) {
      this.close()
      return false
    }
    let chunk: string
    try {
      chunk = serializeSse(event, value, id)
    } catch {
      this.#finish(true)
      return false
    }
    if (Buffer.byteLength(chunk, 'utf8') + this.#queuedBytes + this.#bufferedBytes() > this.#maxBufferedBytes) {
      this.#finish(true)
      return false
    }
    if (this.#waitingDrain) {
      this.#queue(chunk)
      return this.#enforceLimit()
    }
    try {
      const accepted = this.#response.write(chunk)
      if (!accepted) {
        this.#waitingDrain = true
        if (!this.#listenForDrain()) return false
      }
    } catch {
      this.#finish(true)
      return false
    }
    return this.#enforceLimit()
  }

  close(): void {
    // end() waits for queued bytes to flush. A stalled peer will never flush;
    // destroy that transport so the OS buffer/socket is actually released.
    this.#finish(this.#waitingDrain)
  }

  #finish(abort: boolean): void {
    if (this.#closed) return
    this.#closed = true
    this.#queued = []
    this.#queuedBytes = 0
    this.#clearDrain()
    this.#response.removeListener?.('close', this.#onResponseClose)
    this.#response.removeListener?.('error', this.#onResponseError)
    try {
      if (abort && !this.#response.destroyed && typeof this.#response.destroy === 'function') this.#response.destroy()
      else if (!this.#response.writableEnded && !this.#response.destroyed) this.#response.end()
    } catch {
      // Peer teardown must not interrupt publishing to healthy subscribers.
    }
    try { this.#onClose() } catch {
      console.error('[dsh-cyber] SSE subscriber cleanup failed')
    }
  }

  #clearDrain(): void {
    if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer)
    this.#drainTimer = undefined
    this.#waitingDrain = false
    this.#response.removeListener?.('drain', this.#onDrain)
  }

  #bufferedBytes(): number {
    return Number.isSafeInteger(this.#response.writableLength) ? Math.max(0, this.#response.writableLength) : 0
  }

  #queue(chunk: string): void {
    this.#queued.push(chunk)
    this.#queuedBytes += Buffer.byteLength(chunk, 'utf8')
  }

  #enforceLimit(): boolean {
    if (this.#bufferedBytes() + this.#queuedBytes <= this.#maxBufferedBytes) return true
    this.#finish(true)
    return false
  }

  #listenForDrain(): boolean {
    if (typeof this.#response.once !== 'function') {
      this.#finish(true)
      return false
    }
    this.#response.once('drain', this.#onDrain)
    this.#drainTimer = setTimeout(() => this.#finish(true), this.#drainTimeoutMs)
    this.#drainTimer.unref()
    return true
  }

  #drain(): void {
    if (this.closed) { this.close(); return }
    this.#clearDrain()
    while (this.#queued.length > 0) {
      const chunk = this.#queued.shift()!
      this.#queuedBytes -= Buffer.byteLength(chunk, 'utf8')
      try {
        const accepted = this.#response.write(chunk)
        if (!accepted) {
          this.#waitingDrain = true
          if (!this.#listenForDrain()) return
          this.#enforceLimit()
          return
        }
      } catch {
        this.#finish(true)
        return
      }
      if (!this.#enforceLimit()) return
    }
  }
}

export function writeSse(
  response: ServerResponse,
  event: string,
  value: unknown,
  id?: string,
): void {
  if (response.writableEnded || response.destroyed) return
  response.write(serializeSse(event, value, id))
}

function serializeSse(event: string, value: unknown, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
}

export function isSseSequence(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
}

export function sseSequence(value: string | null | undefined): number {
  return value !== null && value !== undefined && isSseSequence(value) ? Number(value) : 0
}
