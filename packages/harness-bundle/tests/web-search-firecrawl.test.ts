import { afterEach, describe, expect, it } from 'vitest'
import { WEB_SEARCH_WORKER_ENV, WEB_SEARCH_WORKER_TOKEN_HEADER } from '@dsh-cyber/contracts'
import { WebError } from '@deepseek-ai/dsh-web'

import { FIRECRAWL_SEARCH_PROVIDER_ID, FirecrawlWebSearchProvider } from '../src/web-search-firecrawl.js'

const ENV_KEYS = [WEB_SEARCH_WORKER_ENV.loopbackOrigin, WEB_SEARCH_WORKER_ENV.workerToken, WEB_SEARCH_WORKER_ENV.workspaceId] as const

function setBridge(origin?: string, token?: string, workspaceId?: string): void {
  if (origin === undefined) delete process.env[WEB_SEARCH_WORKER_ENV.loopbackOrigin]
  else process.env[WEB_SEARCH_WORKER_ENV.loopbackOrigin] = origin
  if (token === undefined) delete process.env[WEB_SEARCH_WORKER_ENV.workerToken]
  else process.env[WEB_SEARCH_WORKER_ENV.workerToken] = token
  if (workspaceId === undefined) delete process.env[WEB_SEARCH_WORKER_ENV.workspaceId]
  else process.env[WEB_SEARCH_WORKER_ENV.workspaceId] = workspaceId
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('worker Firecrawl web-search provider', () => {
  afterEach(() => {
    setBridge()
  })

  it('is dormant until the host injects the loopback coordinates', () => {
    const provider = new FirecrawlWebSearchProvider()
    expect(provider.id).toBe(FIRECRAWL_SEARCH_PROVIDER_ID)
    expect(provider.available()).toBe(false)
    setBridge('http://127.0.0.1:43123', 'tok')
    expect(provider.available()).toBe(true)
  })

  it('calls the host bridge with the token and maps sources', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (_input: unknown, init?: RequestInit) => {
      captured = { url: String(_input), init }
      return Promise.resolve(jsonResponse(200, {
        sources: [{ url: 'https://a.example', title: 'A', snippet: 'a snippet' }, { url: 'https://b.example' }],
        truncated: false,
      }))
    }
    const provider = new FirecrawlWebSearchProvider(fetchImpl as unknown as typeof globalThis.fetch)
    setBridge('http://127.0.0.1:43123', 'tok', 'ws-1')
    const result = await provider.search({ query: 'github ci', maxResults: 5 })
    expect(captured.url).toBe('http://127.0.0.1:43123/api/integrations/firecrawl/search')
    const headers = captured.init?.headers as Record<string, string>
    expect(headers[WEB_SEARCH_WORKER_TOKEN_HEADER]).toBe('tok')
    expect(JSON.parse(String(captured.init?.body))).toMatchObject({ workspaceId: 'ws-1', query: 'github ci', limit: 5 })
    expect(result.truncated).toBe(false)
    expect(result.sources).toEqual([
      { url: 'https://a.example', title: 'A', snippet: 'a snippet' },
      { url: 'https://b.example' },
    ])
  })

  it('surfaces host failure messages as WebError', async () => {
    const fetchImpl = () => Promise.resolve(jsonResponse(409, { error: { code: 'web_search_not_configured', message: '没有可用的 Firecrawl 连接' } }))
    const provider = new FirecrawlWebSearchProvider(fetchImpl as unknown as typeof globalThis.fetch)
    setBridge('http://127.0.0.1:43123', 'tok', 'ws-1')
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    try {
      await provider.search({ query: 'x' })
    } catch (error) {
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).message).toContain('没有可用的 Firecrawl 连接')
    }
  })

  it('fails fast with a missing-configuration error when the bridge is absent', async () => {
    const provider = new FirecrawlWebSearchProvider(() => { throw new Error('no network') })
    await expect(provider.search({ query: 'x' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })
})
