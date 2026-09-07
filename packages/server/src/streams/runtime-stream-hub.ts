import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ConversationControlEnvelope, ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { WorldRuntimeStreamEnvelope, WorldTraceEntry } from '@dsh-cyber/contracts'
import { SseConnection, type SseConnectionOptions } from '../http/sse.js'

interface RuntimeStreamClient {
  worldId: string
  connection: SseConnection
}

export class RuntimeStreamHub {
  readonly #clients = new Set<RuntimeStreamClient>()
  readonly #heartbeat: NodeJS.Timeout
  readonly #connectionOptions: SseConnectionOptions

  constructor(heartbeatMs = 15_000, connectionOptions: SseConnectionOptions = {}) {
    this.#connectionOptions = connectionOptions
    this.#heartbeat = setInterval(() => {
      for (const client of [...this.#clients]) client.connection.send('heartbeat', {})
    }, heartbeatMs)
    this.#heartbeat.unref()
  }

  get clientCount(): number {
    return this.#clients.size
  }

  connect(worldId: string, request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let client: RuntimeStreamClient
    const remove = () => connection.close()
    const connection = new SseConnection(response, () => {
      this.#clients.delete(client)
      request.removeListener('close', remove)
      request.removeListener('aborted', remove)
    }, this.#connectionOptions)
    client = { worldId, connection }
    this.#clients.add(client)
    request.once('aborted', remove)
    request.once('close', remove)
    connection.send('ready', {})
  }

  publish(event: ConversationRealtimeEnvelope): void {
    for (const client of [...this.#clients]) {
      if (client.worldId !== event.worldId) continue
      client.connection.send('runtime', event)
    }
  }

  publishControl(event: ConversationControlEnvelope): void {
    for (const client of [...this.#clients]) {
      if (client.worldId !== event.worldId) continue
      client.connection.send('conversation-control', event)
    }
  }

  publishTrace(worldId: string, entries: WorldTraceEntry[]): void {
    if (entries.length === 0) return
    for (const client of [...this.#clients]) {
      if (client.worldId !== worldId) continue
      for (const entry of entries) if (!client.connection.send('trace', entry)) break
    }
  }

  publishWorld(event: WorldRuntimeStreamEnvelope): void {
    const eventName = event.kind === 'runtime' ? 'world-runtime' : event.kind
    for (const client of [...this.#clients]) {
      if (client.worldId !== event.worldId) continue
      client.connection.send(eventName, event)
    }
  }

  close(): void {
    clearInterval(this.#heartbeat)
    for (const client of [...this.#clients]) client.connection.close()
    this.#clients.clear()
  }
}
