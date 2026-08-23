import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Browsers and WHATWG fetch reject these legacy service ports even on loopback.
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])

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

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => { server.close((error) => (error === undefined ? resolvePromise() : reject(error))) })
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
