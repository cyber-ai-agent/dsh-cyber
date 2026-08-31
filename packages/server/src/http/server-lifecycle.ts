import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Browsers and WHATWG fetch reject these legacy service ports even on loopback.
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])

/**
 * Browser surfaces can keep a response alive after the UI that owned it is
 * already gone (SSE, iframe previews, fetch streams). A local desktop server
 * must still have a bounded shutdown: otherwise restart/update/backup flows can
 * hang forever waiting for one stale TCP connection.
 *
 * Give active requests a short graceful window first. Idle keep-alives are
 * closed immediately; only connections still alive after the grace period are
 * force-closed, and only after `server.close()` has stopped accepting new ones.
 */
const DEFAULT_CLOSE_GRACE_MS = 1_000

export async function listenBrowserSafe(server: Server, port: number, host: string): Promise<AddressInfo> {
  let address: ReturnType<typeof server.address> = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await listen(server, port, host)
    address = server.address()
    if (address !== null && typeof address !== 'string' && (port !== 0 || !FETCH_BLOCKED_PORTS.has(address.port))) return address
    await closeServer(server)
  }
  if (address === null || typeof address === 'string') throw new Error('Server did not expose a TCP address')
  throw new Error('Server could not allocate a browser-safe TCP port')
}

export function closeServer(server: Server, graceMs: number = DEFAULT_CLOSE_GRACE_MS): Promise<void> {
  if (!Number.isFinite(graceMs) || graceMs < 0) return Promise.reject(new Error('Server close grace period must be a non-negative number'))
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (forceTimer !== undefined) clearTimeout(forceTimer)
      if (error === undefined) resolvePromise()
      else rejectPromise(error)
    }
    try {
      server.close((error) => finish(error))
      // Since Node 18.2 these are public APIs. Keep the optional guard so the
      // lifecycle helper remains safe for alternative Server implementations.
      server.closeIdleConnections?.()
      forceTimer = setTimeout(() => {
        // Do not call this before `close()`: otherwise a new connection could
        // arrive in the gap and recreate the same shutdown race.
        server.closeAllConnections?.()
      }, graceMs)
      forceTimer.unref?.()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolvePromise() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
