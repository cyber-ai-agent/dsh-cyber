import type { IncomingMessage } from 'node:http'

import { HttpError } from './errors.js'

export function assertLocalRequest(request: IncomingMessage): void {
  const hostHeader = request.headers.host
  if (hostHeader === undefined) throw new HttpError(400, 'host_required', 'Host header required')
  let host: string
  try {
    host = new URL(`http://${hostHeader}`).hostname
  } catch {
    throw new HttpError(400, 'invalid_host', 'Invalid Host header')
  }
  if (!isLoopbackHost(host)) throw new HttpError(403, 'non_loopback_host', 'Non-loopback host rejected')
  const origin = request.headers.origin
  if (origin !== undefined && origin !== `http://${hostHeader}`) {
    throw new HttpError(403, 'origin_rejected', 'Cross-origin request rejected')
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers['content-type'] ?? ''
    if (!String(contentType).toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'json_required', 'Application JSON content type required')
    }
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}
