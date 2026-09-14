import type { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { WEB_SEARCH_WORKER_ENV, WEB_SEARCH_WORKER_TOKEN_HEADER } from '@dsh-cyber/contracts'

export const FIRECRAWL_SEARCH_PROVIDER_ID = 'firecrawl'

/**
 * The 连接中心「联网搜索」Firecrawl backend, registered on the worker's DSH
 * `web` seam. It never holds a Firecrawl credential: it calls the DSH Cyber
 * host over loopback with the per-launch worker token, and the host runs the
 * search against the workspace's Firecrawl connection. `available()` is a
 * cheap env check, so the provider is dormant until the host injects the
 * bridge coordinates into the launch environment.
 */
export class FirecrawlWebSearchProvider implements WebSearchProvider {
  readonly id = FIRECRAWL_SEARCH_PROVIDER_ID
  readonly #fetch: typeof globalThis.fetch
  constructor(fetchImpl?: typeof globalThis.fetch) {
    this.#fetch = fetchImpl ?? globalThis.fetch
  }
  available(): boolean {
    return nonEmpty(process.env[WEB_SEARCH_WORKER_ENV.loopbackOrigin])
      && nonEmpty(process.env[WEB_SEARCH_WORKER_ENV.workerToken])
  }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const origin = process.env[WEB_SEARCH_WORKER_ENV.loopbackOrigin]?.trim()
    const token = process.env[WEB_SEARCH_WORKER_ENV.workerToken]?.trim()
    const workspaceId = process.env[WEB_SEARCH_WORKER_ENV.workspaceId]?.trim()
    if (origin === undefined || origin === '' || token === undefined || token === '' || workspaceId === undefined || workspaceId === '') {
      throw new WebError('Firecrawl 联网搜索未配置（缺少宿主回环地址）', 'WEB_PROVIDER_UNAVAILABLE')
    }
    let response: Response
    try {
      response = await this.#fetch(`${origin}/api/integrations/firecrawl/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [WEB_SEARCH_WORKER_TOKEN_HEADER]: token,
        },
        body: JSON.stringify({ workspaceId, query: request.query, ...(request.maxResults === undefined ? {} : { limit: request.maxResults }) }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted === true) throw new WebError('Firecrawl 联网搜索已取消', 'WEB_ABORTED')
      throw new WebError('无法连接本机服务，联网搜索暂不可用', 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      const payload = await safeErrorBody(response)
      const message = payload?.message ?? `Firecrawl 搜索请求失败（HTTP ${response.status}）`
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }
    const result = await response.json() as { sources?: Array<{ url?: unknown; title?: unknown; snippet?: unknown }>; truncated?: unknown }
    const sources: WebSearchSource[] = (Array.isArray(result.sources) ? result.sources : []).flatMap((item): WebSearchSource[] => {
      const url = typeof item.url === 'string' ? item.url.trim() : ''
      if (url === '') return []
      const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title : undefined
      const snippet = typeof item.snippet === 'string' && item.snippet.trim() !== '' ? item.snippet : undefined
      return [{ url, ...(title === undefined ? {} : { title }), ...(snippet === undefined ? {} : { snippet }) }]
    })
    return { sources, truncated: result.truncated === true }
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== ''
}

async function safeErrorBody(response: Response): Promise<{ message?: string } | undefined> {
  try {
    const payload = await response.json() as { error?: { message?: unknown } }
    return payload?.error?.message !== undefined ? { message: String(payload.error.message) } : undefined
  } catch {
    return undefined
  }
}

/** Register the provider on the worker's `web` seam (dormant until configured). */
export function registerFirecrawlWebSearch(ctx: Context, fetchImpl?: typeof globalThis.fetch): void {
  const provider = new FirecrawlWebSearchProvider(fetchImpl)
  ctx.effect(() => {
    const dispose = ctx.web.registerSearchProvider(provider)
    return () => dispose()
  }, 'web-search-firecrawl.register')
}
