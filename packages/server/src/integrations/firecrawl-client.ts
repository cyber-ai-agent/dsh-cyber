import { isIP } from 'node:net'

import { firecrawlBaseUrl, FIRECRAWL_INTEGRATION_ID } from './firecrawl-provider.js'
import type { JsonObject } from '@dsh-cyber/contracts'

/**
 * The transport shared by the Firecrawl Skill and the Knowledge Library.
 *
 * Credentials stay owned by IntegrationService.  This class deliberately
 * accepts the small read-only part of that service instead of the concrete
 * implementation so it can be used by feature services and tests without
 * creating a second credential/configuration path.
 */
export interface FirecrawlIntegrationSource {
  get(workspaceId: string, integrationId: string): { enabled: boolean; config: JsonObject } | undefined
  credential(workspaceId: string, integrationId: string): string | undefined
}

export interface FirecrawlSearchItem {
  title: string
  url: string
  description?: string
}

export interface FirecrawlScrapeResult {
  url: string
  title?: string
  markdown: string
  fetchedAt: string
}

export interface FirecrawlClientOptions {
  integrations: FirecrawlIntegrationSource
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxResponseBytes?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 12 * 1024 * 1024

export class FirecrawlClient {
  readonly #integrations: FirecrawlIntegrationSource
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number

  constructor(options: FirecrawlClientOptions) {
    this.#integrations = options.integrations
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000)
    this.#maxResponseBytes = boundedPositive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024, 64 * 1024 * 1024)
  }

  async search(input: { workspaceId: string; query: string; limit?: number }): Promise<FirecrawlSearchItem[]> {
    const query = normalizeQuery(input.query)
    const limit = boundedPositive(input.limit, 5, 1, 20)
    const payload = await this.#request(input.workspaceId, '/v2/search', {
      query,
      limit,
      sources: ['web'],
    })
    return parseSearch(payload, limit)
  }

  async scrape(input: { workspaceId: string; url: string }): Promise<FirecrawlScrapeResult> {
    const url = normalizePublicWebUrl(input.url)
    const payload = await this.#request(input.workspaceId, '/v2/scrape', {
      url,
      formats: ['markdown'],
    })
    return parseScrape(payload, url)
  }

  async #request(workspaceId: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    const connection = this.#integrations.get(workspaceId, FIRECRAWL_INTEGRATION_ID)
    const credential = this.#integrations.credential(workspaceId, FIRECRAWL_INTEGRATION_ID)
    if (connection === undefined || !connection.enabled || credential === undefined || credential.trim() === '') {
      throw new FirecrawlClientError('not-configured', 'Firecrawl 连接尚未启用或缺少凭据')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(`${firecrawlBaseUrl(connection.config) ?? ''}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new FirecrawlClientError('http', firecrawlFailure(response.status), response.status)
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && Number(contentLength) > this.#maxResponseBytes) {
        throw new FirecrawlClientError('too-large', 'Firecrawl 返回内容超过大小限制')
      }
      const text = await readBoundedResponseText(response, this.#maxResponseBytes)
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new FirecrawlClientError('invalid-response', 'Firecrawl 返回了无法识别的 JSON')
      }
    } catch (error) {
      if (error instanceof FirecrawlClientError) throw error
      const aborted = error instanceof Error && error.name === 'AbortError'
      if (aborted) throw new FirecrawlClientError('outcome-unknown', 'Firecrawl 请求超时，外部请求结果未知；不得自动重试')
      if (isConnectionRefused(error)) throw new FirecrawlClientError('unreachable', 'Firecrawl 连接被拒绝，请求未发出')
      throw new FirecrawlClientError('outcome-unknown', 'Firecrawl 请求连接中断，外部请求结果未知；不得自动重试')
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new FirecrawlClientError('too-large', 'Firecrawl 返回内容超过大小限制')
    return text
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new FirecrawlClientError('too-large', 'Firecrawl 返回内容超过大小限制')
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export type FirecrawlClientErrorKind = 'not-configured' | 'http' | 'too-large' | 'invalid-response' | 'outcome-unknown' | 'unreachable'

export class FirecrawlClientError extends Error {
  constructor(readonly kind: FirecrawlClientErrorKind, message: string, readonly status?: number) {
    super(message)
    this.name = 'FirecrawlClientError'
  }
}

function parseSearch(value: unknown, limit: number): FirecrawlSearchItem[] {
  const root = asRecord(value)
  const data = asRecord(root?.data)
  const web = data?.web
  if (!Array.isArray(web)) throw new FirecrawlClientError('invalid-response', 'Firecrawl 返回了无法识别的搜索结果')
  return web.slice(0, limit).flatMap((item): FirecrawlSearchItem[] => {
    const row = asRecord(item)
    const url = typeof row?.url === 'string' ? row.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return []
    const title = typeof row?.title === 'string' ? cleanText(row.title, 160) : url
    const description = typeof row?.description === 'string' ? cleanText(row.description, 320) : undefined
    return [{ title: title || url, url, ...(description ? { description } : {}) }]
  })
}

function parseScrape(value: unknown, requestedUrl: string): FirecrawlScrapeResult {
  const root = asRecord(value)
  const data = asRecord(root?.data) ?? root
  if (data === undefined) throw new FirecrawlClientError('invalid-response', 'Firecrawl 返回了无法识别的网页内容')
  const markdown = typeof data.markdown === 'string' ? data.markdown : typeof data.content === 'string' ? data.content : undefined
  if (markdown === undefined || markdown.trim() === '') throw new FirecrawlClientError('invalid-response', 'Firecrawl 返回的网页没有可索引正文')
  const metadata = asRecord(data.metadata)
  const title = typeof metadata?.title === 'string' ? cleanText(metadata.title, 240) : undefined
  const canonical = typeof metadata?.sourceURL === 'string' && /^https?:\/\//i.test(metadata.sourceURL)
    ? metadata.sourceURL
    : requestedUrl
  return { url: canonical, ...(title ? { title } : {}), markdown: cleanText(markdown, 4_000_000), fetchedAt: new Date().toISOString() }
}

function normalizeQuery(value: string): string {
  const query = value.trim().replace(/\s+/g, ' ')
  if (query.length === 0 || query.length > 500) throw new FirecrawlClientError('invalid-response', 'Firecrawl 查询文本无效')
  return query
}

/** Reject local and private targets before they are handed to an external crawler. */
export function normalizePublicWebUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new FirecrawlClientError('invalid-response', '网页地址无效') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FirecrawlClientError('invalid-response', '网页地址必须使用 HTTP(S)')
  if (url.username || url.password || url.hash) throw new FirecrawlClientError('invalid-response', '网页地址不能包含凭据或片段')
  if (isPrivateHost(url.hostname)) throw new FirecrawlClientError('invalid-response', '不能导入本机或私有网络地址')
  return url.toString()
}

function firecrawlFailure(status: number): string {
  if (status === 401 || status === 403) return 'Firecrawl 凭据无效或没有访问权限'
  if (status === 402) return 'Firecrawl 账户额度不足'
  if (status === 429) return 'Firecrawl 请求过于频繁，请稍后重试'
  return `Firecrawl 请求失败（HTTP ${status}）`
}

function isConnectionRefused(error: unknown): boolean {
  const value = error as { cause?: { code?: unknown }; code?: unknown } | null
  const code = value?.cause?.code ?? value?.code
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function cleanText(value: string, max: number): string { return value.replace(/\s+/g, ' ').trim().slice(0, max) }

function boundedPositive(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)))
}

function isPrivateHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true
  const addressType = isIP(host)
  if (addressType === 4) return isPrivateIpv4(host)
  if (addressType === 6) return isPrivateIpv6(host)
  // Hostnames can still resolve to private addresses after this check. The
  // configured Firecrawl service is the final egress boundary; rejecting
  // local labels here prevents the common direct SSRF forms without doing a
  // potentially inconsistent second DNS lookup in the client.
  return false
}

function isPrivateIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  const first = octets[0]!
  const second = octets[1]
  return !octets.some((item) => item > 255) && (
    first === 0 || first === 10 || first === 127 || (first === 100 && second !== undefined && second >= 64 && second <= 127) || (first === 169 && second === 254)
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0)
    || (first === 192 && second === 2)
    || (first === 198 && second !== undefined && second >= 18 && second <= 19)
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first >= 224
  )
}

function isPrivateIpv6(value: string): boolean {
  const words = parseIpv6(value)
  if (words === undefined) return true
  const allZero = words.every((word) => word === 0)
  if (allZero || (allZeroExceptLast(words) && words[7] === 1)) return true
  if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80 || (words[0]! & 0xffc0) === 0xfec0 || (words[0]! & 0xff00) === 0xff00) return true
  // IPv4-mapped and IPv4-compatible IPv6 literals must not bypass the IPv4
  // private-range checks by spelling 127.0.0.1 as an IPv6 address.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return isPrivateIpv4(`${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`)
  }
  return false
}

function allZeroExceptLast(words: readonly number[]): boolean { return words.slice(0, 7).every((word) => word === 0) }

function parseIpv6(value: string): number[] | undefined {
  if (value.includes(':::') || (value.match(/::/g) ?? []).length > 1) return undefined
  const [headText, tailText] = value.split('::')
  const parsePart = (part: string): number[] | undefined => part === '' ? [] : part.split(':').flatMap((item, index, items) => {
    if (item.includes('.')) {
      if (index !== items.length - 1) return []
      const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(item)
      if (match === null) return []
      const octets = match.slice(1).map(Number)
      if (octets.some((octet) => octet > 255)) return []
      return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!]
    }
    if (!/^[0-9a-f]{1,4}$/i.test(item)) return []
    return [Number.parseInt(item, 16)]
  })
  const head = parsePart(headText ?? '')
  const tail = parsePart(tailText ?? '')
  if (head === undefined || tail === undefined) return undefined
  if (value.includes('::')) {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return undefined
    return [...head, ...Array.from({ length: missing }, () => 0), ...tail]
  }
  return head.length === 8 ? head : undefined
}
