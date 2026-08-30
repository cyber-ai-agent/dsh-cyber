import type { IncomingMessage, ServerResponse } from 'node:http'

import { HttpError } from './errors.js'
import { assertLocalRequest } from './security.js'
import { serveWebAsset } from './static-files.js'

export interface HttpRouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  method: string
  params: readonly string[]
}

export type HttpRouteHandler = (context: HttpRouteContext) => Promise<void> | void

export interface HttpDispatcher {
  dispatch(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

export async function dispatchHttpRequest(
  router: HttpDispatcher,
  webRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  assertLocalRequest(request)
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const method = request.method ?? 'GET'
  if ((method === 'GET' || method === 'HEAD') && !url.pathname.startsWith('/api/')) {
    if (await serveWebAsset(response, webRoot, url.pathname, method === 'HEAD')) return
  }
  if (await router.dispatch(request, response)) return
  throw new HttpError(404, 'not_found', 'Route not found')
}
