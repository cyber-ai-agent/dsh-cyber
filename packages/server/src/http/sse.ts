import type { ServerResponse } from 'node:http'

/**
 * A live view can always recover from the latest snapshot after reconnecting.
 * That makes disconnecting a client which cannot keep up safer than allowing
 * Node's writable buffer to grow without a bound.
 */
export const DEFAULT_SSE_MAX_BUFFERED_BYTES = 64 * 1024

export interface SseConnectionOptions {
  maxBufferedBytes?: number
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
  #queued: string[] = []
  #queuedBytes = 0
  #waitingDrain = false
  #closed = false

  constructor(response: ServerResponse, onClose: () => void, options: SseConnectionOptions = {}) {
    const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_SSE_MAX_BUFFERED_BYTES
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
      throw new Error('SSE maximum buffered bytes must be a positive safe integer')
    }
    this.#response = response
    this.#maxBufferedBytes = maxBufferedBytes
    this.#onClose = onClose
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
      this.close()
      return false
    }
    if (Buffer.byteLength(chunk, 'utf8') > this.#maxBufferedBytes) {
      this.close()
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
      this.close()
      return false
    }
    return this.#enforceLimit()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#queued = []
    this.#queuedBytes = 0
    try {
      if (!this.#response.writableEnded && !this.#response.destroyed) this.#response.end()
    } catch {
      // A response may already be torn down by the peer. The owner callback is
      // still invoked below so the hub cannot retain a dead subscriber.
    }
    this.#onClose()
  }

  #queue(chunk: string): void {
    this.#queued.push(chunk)
    this.#queuedBytes += Buffer.byteLength(chunk, 'utf8')
  }

  #enforceLimit(): boolean {
    const responseBytes = Number.isSafeInteger(this.#response.writableLength)
      ? this.#response.writableLength
      : 0
    if (responseBytes + this.#queuedBytes <= this.#maxBufferedBytes) return true
    this.close()
    return false
  }

  #listenForDrain(): boolean {
    if (typeof this.#response.once !== 'function') {
      this.close()
      return false
    }
    this.#response.once('drain', () => this.#drain())
    return true
  }

  #drain(): void {
    if (this.#closed) return
    this.#waitingDrain = false
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
        this.close()
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
