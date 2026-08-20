import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  JsonObject,
  WorldRuntimeSnapshot,
  WorldRuntimeStreamEnvelope,
} from '@dsh-cyber/contracts'

import { headerValue } from '../http/request.js'
import { isSseSequence, sseSequence, writeSse } from '../http/sse.js'

interface WorldStreamClient {
  worldId: string
  response: ServerResponse
  lastSequence: number
}

export class WorldStreamHub {
  readonly #clients = new Set<WorldStreamClient>()
  readonly #heartbeat: NodeJS.Timeout

  constructor(heartbeatMs = 15_000) {
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) {
        const heartbeatEvent: WorldRuntimeStreamEnvelope = {
          contractVersion: 1,
          id: String(client.lastSequence),
          worldId: client.worldId,
          sequence: client.lastSequence,
          kind: 'heartbeat',
          payload: {},
          createdAt: new Date().toISOString(),
        }
        writeSse(client.response, 'heartbeat', heartbeatEvent, heartbeatEvent.id)
      }
    }, heartbeatMs)
    this.#heartbeat.unref()
  }

  get clientCount(): number {
    return this.#clients.size
  }

  connect(
    worldId: string,
    request: IncomingMessage,
    response: ServerResponse,
    snapshot: WorldRuntimeSnapshot,
    afterParameter: string | null,
  ): void {
    const lastEventId = headerValue(request.headers['last-event-id'])
    const invalidCursor = (afterParameter !== null && !isSseSequence(afterParameter)) ||
      (lastEventId !== null && !isSseSequence(lastEventId))
    const after = Math.max(sseSequence(afterParameter), sseSequence(lastEventId))
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    if (invalidCursor || after !== snapshot.sequence) {
      const recoveryRequired: WorldRuntimeStreamEnvelope = {
        contractVersion: 1,
        id: String(snapshot.sequence),
        worldId,
        sequence: snapshot.sequence,
        kind: 'recovery-required',
        payload: {
          requestedSequence: after,
          latestSequence: snapshot.sequence,
          reason: invalidCursor ? 'invalid-cursor' : after > snapshot.sequence ? 'cursor-ahead' : 'cursor-gap',
        },
        createdAt: new Date().toISOString(),
      }
      writeSse(response, 'recovery-required', recoveryRequired, recoveryRequired.id)
      const recoveryState: WorldRuntimeStreamEnvelope = {
        contractVersion: 1,
        id: String(snapshot.sequence),
        worldId,
        sequence: snapshot.sequence,
        kind: 'world-state',
        payload: snapshot as unknown as JsonObject,
        createdAt: new Date().toISOString(),
      }
      writeSse(response, 'world-state', recoveryState, recoveryState.id)
    } else {
      writeSse(response, 'ready', {
        contractVersion: 1,
        id: String(snapshot.sequence),
        worldId,
        sequence: snapshot.sequence,
        kind: 'heartbeat',
        payload: {},
        createdAt: new Date().toISOString(),
      }, String(snapshot.sequence))
    }
    const client = { worldId, response, lastSequence: snapshot.sequence }
    this.#clients.add(client)
    request.once('close', () => this.#clients.delete(client))
  }

  publish(event: WorldRuntimeStreamEnvelope): void {
    for (const client of this.#clients) {
      if (client.worldId !== event.worldId) continue
      writeSse(client.response, event.kind, event, event.id)
      client.lastSequence = Math.max(client.lastSequence, event.sequence)
    }
  }

  close(): void {
    clearInterval(this.#heartbeat)
    for (const client of this.#clients) client.response.end()
    this.#clients.clear()
  }
}
