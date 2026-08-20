import type { IncomingMessage, ServerResponse } from 'node:http'

export interface HttpRouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  method: string
  params: readonly string[]
}

export type HttpRouteHandler = (context: HttpRouteContext) => Promise<void> | void
