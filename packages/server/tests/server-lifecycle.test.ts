import { createServer, get, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { closeServer } from '../src/http/server-lifecycle.js'

describe('HTTP server lifecycle', () => {
  it('closes normally without waiting for the force window when there are no active clients', async () => {
    const server = createServer((_request, response) => response.end('ok'))
    await listen(server)

    await expect(closeServer(server, 2_000)).resolves.toBeUndefined()
    expect(server.listening).toBe(false)
  })

  it('bounds shutdown when a browser-style streaming response never ends', async () => {
    let streamResponse: ServerResponse | undefined
    const streamStarted = deferred<void>()
    const server = createServer((_request, response) => {
      streamResponse = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: ready\ndata: {}\n\n')
      streamStarted.resolve()
      // Intentionally never end: this reproduces a stale SSE/iframe-style
      // connection that used to keep CyberServer.close() alive indefinitely.
    })
    const address = await listen(server)
    const request = get(`http://127.0.0.1:${address.port}/stream`)
    request.on('error', () => undefined)
    await streamStarted.promise

    const outcome = await Promise.race([
      closeServer(server, 20).then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ])

    expect(outcome).toBe('closed')
    expect(server.listening).toBe(false)
    expect(streamResponse?.destroyed).toBe(true)
    request.destroy()
  })

  it('rejects an invalid grace period instead of creating an unbounded timer contract', async () => {
    const server = createServer()
    await listen(server)
    await expect(closeServer(server, -1)).rejects.toThrow(/grace period/u)
    await closeServer(server, 0)
  })
})

function listen(server: ReturnType<typeof createServer>): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('test server did not expose a TCP address'))
        return
      }
      resolve(address)
    })
  })
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
