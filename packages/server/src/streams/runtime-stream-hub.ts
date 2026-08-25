import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ConversationControlEnvelope, ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'
import type { WorldRuntimeStreamEnvelope, WorldTraceEntry } from '@dsh-cyber/contracts'

interface RuntimeStreamClient {
  worldId: string
  response: ServerResponse
}

export class RuntimeStreamHub {
  readonly #clients = new Set<RuntimeStreamClient>()
  readonly #heartbeat: NodeJS.Timeout

  constructor(heartbeatMs = 15_000) {
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) client.response.write(': heartbeat\n\n')
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
    response.write('event: ready\ndata: {}\n\n')
    const client = { worldId, response }
    this.#clients.add(client)
    const remove = () => this.#clients.delete(client)
    if (typeof response.once === 'function') response.once('close', remove)
    request.once('aborted', remove)
    request.once('close', remove)
  }

  publish(event: ConversationRealtimeEnvelope): void {
    const data = JSON.stringify(event)
    for (const client of this.#clients) {
      if (client.worldId !== event.worldId) continue
      client.response.write(`event: runtime\ndata: ${data}\n\n`)
    }
  }

  publishControl(event: ConversationControlEnvelope): void {
    const data = JSON.stringify(event)
    for (const client of this.#clients) {
      if (client.worldId !== event.worldId) continue
      client.response.write(`event: conversation-control\ndata: ${data}\n\n`)
    }
  }

  publishTrace(worldId: string, entries: WorldTraceEntry[]): void {
    if (entries.length === 0) return
    for (const client of this.#clients) {
      if (client.worldId !== worldId) continue
      for (const entry of entries) {
        client.response.write(`event: trace\ndata: ${JSON.stringify(entry)}\n\n`)
      }
    }
  }

  publishWorld(event: WorldRuntimeStreamEnvelope): void {
    const eventName = event.kind === 'runtime' ? 'world-runtime' : event.kind
    const data = JSON.stringify(event)
    for (const client of this.#clients) {
      if (client.worldId !== event.worldId) continue
      client.response.write(`event: ${eventName}\ndata: ${data}\n\n`)
    }
  }

  close(): void {
    clearInterval(this.#heartbeat)
    for (const client of this.#clients) client.response.end()
    this.#clients.clear()
  }
}
