import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ConversationRealtimeEnvelope } from '@dsh-cyber/orchestration'

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
    request.once('close', () => this.#clients.delete(client))
  }

  publish(event: ConversationRealtimeEnvelope): void {
    const data = JSON.stringify(event)
    for (const client of this.#clients) {
      if (client.worldId !== event.worldId) continue
      client.response.write(`event: runtime\ndata: ${data}\n\n`)
    }
  }

  close(): void {
    clearInterval(this.#heartbeat)
    for (const client of this.#clients) client.response.end()
    this.#clients.clear()
  }
}
