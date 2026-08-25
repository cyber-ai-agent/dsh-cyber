import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HttpRouteHandler } from './context.js'

export type HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT'
export type HttpRoutePattern = string | RegExp

interface RegisteredRoute {
  method: HttpMethod
  pattern: HttpRoutePattern
  handler: HttpRouteHandler
}

export class Router {
  readonly #routes: RegisteredRoute[] = []

  route(method: HttpMethod, pattern: HttpRoutePattern, handler: HttpRouteHandler): void {
    this.#routes.push({ method, pattern, handler })
  }

  get(pattern: HttpRoutePattern, handler: HttpRouteHandler): void {
    this.route('GET', pattern, handler)
  }

  post(pattern: HttpRoutePattern, handler: HttpRouteHandler): void {
    this.route('POST', pattern, handler)
  }

  put(pattern: HttpRoutePattern, handler: HttpRouteHandler): void {
    this.route('PUT', pattern, handler)
  }

  patch(pattern: HttpRoutePattern, handler: HttpRouteHandler): void {
    this.route('PATCH', pattern, handler)
  }

  delete(pattern: HttpRoutePattern, handler: HttpRouteHandler): void {
    this.route('DELETE', pattern, handler)
  }

  async dispatch(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    for (const route of this.#routes) {
      if (route.method !== method) continue
      const params = matchRoute(url.pathname, route.pattern)
      if (params === undefined) continue
      await route.handler({ request, response, url, method, params })
      return true
    }
    return false
  }
}

export function matchRoute(pathname: string, pattern: HttpRoutePattern): readonly string[] | undefined {
  if (typeof pattern === 'string') return pathname === pattern ? [] : undefined
  pattern.lastIndex = 0
  const result = pattern.exec(pathname)
  if (result === null) return undefined
  return result.slice(1).map((value) => decodeURIComponent(value))
}

export function match(pathname: string, expression: RegExp): [string, ...string[]] | undefined {
  const values = matchRoute(pathname, expression)
  if (values === undefined) return undefined
  const first = values[0]
  return first === undefined ? undefined : [first, ...values.slice(1)]
}
