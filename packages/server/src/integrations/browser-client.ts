import { createHash } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright'

import {
  BrowserPolicy,
  BrowserPolicyError,
  type BrowserResolvedTarget,
} from '../services/browser-policy.js'

export interface BrowserPageInfo {
  url: string
  title: string
  statusCode: number
}

export interface BrowserReadResult extends BrowserPageInfo {
  text: string
}

export interface BrowserExtractResult extends BrowserPageInfo {
  items: Array<{ selector: string; text: string }>
}

export interface BrowserScreenshotResult extends BrowserPageInfo {
  bytes: Buffer
  width: number
  height: number
  sha256: string
}

export interface BrowserFetchedDocument {
  url: string
  statusCode: number
  headers: Record<string, string>
  body: Buffer
}

export interface BrowserDocumentFetcherInput {
  policy: BrowserPolicy
  target: BrowserResolvedTarget
  url: string
}

export type BrowserDocumentFetcher = (input: BrowserDocumentFetcherInput) => Promise<BrowserFetchedDocument>

/**
 * A response returned by the host-controlled document transport. Keeping this
 * below the BrowserClient interface makes the byte cap testable without ever
 * giving untrusted page content a network-capable Playwright page.
 */
export interface BrowserPinnedResponse {
  statusCode: number
  headers: Record<string, string>
  remoteAddress?: string
  body: AsyncIterable<Uint8Array>
  cancel: (reason?: Error) => void
}

export interface BrowserPinnedRequestInput {
  policy: BrowserPolicy
  target: BrowserResolvedTarget
  url: URL
}

export type BrowserPinnedRequester = (input: BrowserPinnedRequestInput) => Promise<BrowserPinnedResponse>

export interface BrowserClient {
  open(url: string): Promise<BrowserPageInfo>
  read(url: string): Promise<BrowserReadResult>
  extract(input: { url: string; selector: string }): Promise<BrowserExtractResult>
  screenshot(input: { url: string; width?: number; height?: number }): Promise<BrowserScreenshotResult>
  close(): Promise<void>
}

export interface BrowserClientFactory {
  create(policy: BrowserPolicy, target: BrowserResolvedTarget): Promise<BrowserClient>
}

export class BrowserClientError extends Error {
  constructor(readonly kind: 'download' | 'navigation' | 'outcome-unknown' | 'browser-unavailable', message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BrowserClientError'
  }
}

/** Default host Browser client. Every action gets a fresh, non-persistent context. */
export class PlaywrightBrowserClientFactory implements BrowserClientFactory {
  readonly #documentFetcher: BrowserDocumentFetcher

  constructor(options: { documentFetcher?: BrowserDocumentFetcher } = {}) {
    this.#documentFetcher = options.documentFetcher ?? fetchPinnedDocument
  }

  async create(policy: BrowserPolicy, target: BrowserResolvedTarget): Promise<BrowserClient> {
    let browser: Browser
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          `--host-resolver-rules=MAP ${target.hostname} ${target.pinnedAddress.includes(':') ? `[${target.pinnedAddress}]` : target.pinnedAddress}`,
          '--proxy-server=direct://',
          '--proxy-bypass-list=*',
        ],
      })
    } catch (error) {
      throw new BrowserClientError('browser-unavailable', '受信任浏览器运行环境不可用', { cause: error })
    }
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: false,
        serviceWorkers: 'block',
      })
      const client = new PlaywrightBrowserClient(browser, context, policy, target, this.#documentFetcher)
      await client.ready()
      return client
    } catch (error) {
      await browser.close().catch(() => undefined)
      throw new BrowserClientError('browser-unavailable', '受信任浏览器上下文无法创建', { cause: error })
    }
  }
}

class PlaywrightBrowserClient implements BrowserClient {
  readonly #browser: Browser
  readonly #context: BrowserContext
  readonly #policy: BrowserPolicy
  readonly #target: BrowserResolvedTarget
  readonly #documentFetcher: BrowserDocumentFetcher
  #mainPage: Page | undefined
  #policyError: BrowserPolicyError | undefined
  #downloadDetected = false
  readonly #guardsReady: Promise<void>

  constructor(browser: Browser, context: BrowserContext, policy: BrowserPolicy, target: BrowserResolvedTarget, documentFetcher: BrowserDocumentFetcher) {
    this.#browser = browser
    this.#context = context
    this.#policy = policy
    this.#target = target
    this.#documentFetcher = documentFetcher
    this.#guardsReady = this.#installGuards()
  }

  ready(): Promise<void> { return this.#guardsReady }

  async open(url: string): Promise<BrowserPageInfo> {
    const navigation = await this.#navigate(url)
    try {
      return navigation.info
    } finally {
      await navigation.page.close().catch(() => undefined)
    }
  }

  async read(url: string): Promise<BrowserReadResult> {
    const navigation = await this.#navigate(url)
    try {
      const text = this.#policy.assertText(await navigation.page.locator('body').innerText({ timeout: this.#policy.limits.timeoutMs }))
      return { ...navigation.info, text }
    } finally {
      await navigation.page.close().catch(() => undefined)
    }
  }

  async extract(input: { url: string; selector: string }): Promise<BrowserExtractResult> {
    const selector = this.#policy.assertSelector(input.selector)
    const navigation = await this.#navigate(input.url)
    try {
      const locator = navigation.page.locator(selector)
      const count = Math.min(await locator.count(), 100)
      const items: Array<{ selector: string; text: string }> = []
      let totalText = 0
      for (let index = 0; index < count; index += 1) {
        const text = (await locator.nth(index).innerText({ timeout: this.#policy.limits.timeoutMs })).trim()
        totalText += text.length
        this.#policy.assertText('x'.repeat(totalText))
        if (text) items.push({ selector, text })
      }
      return { ...navigation.info, items }
    } finally {
      await navigation.page.close().catch(() => undefined)
    }
  }

  async screenshot(input: { url: string; width?: number; height?: number }): Promise<BrowserScreenshotResult> {
    const viewport = this.#policy.assertViewport(input.width, input.height)
    const page = await this.#newPage()
    try {
      await page.setViewportSize(viewport)
      const navigation = await this.#navigateOnPage(page, input.url)
      const bytes = await page.screenshot({ type: 'png', fullPage: false })
      if (bytes.byteLength > this.#policy.limits.maxScreenshotBytes) {
        throw new BrowserPolicyError('too-large', '浏览器截图超过大小限制')
      }
      const dimensions = pngDimensions(bytes)
      if (dimensions === undefined || dimensions.width > this.#policy.limits.maxScreenshotWidth || dimensions.height > this.#policy.limits.maxScreenshotHeight) {
        throw new BrowserPolicyError('invalid-viewport', '浏览器截图尺寸超过限制')
      }
      return {
        ...navigation.info,
        bytes,
        width: dimensions.width,
        height: dimensions.height,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    await this.#context.close().catch(() => undefined)
    await this.#browser.close().catch(() => undefined)
  }

  async #navigate(url: string): Promise<{ page: Page; info: BrowserPageInfo }> {
    const page = await this.#newPage()
    try {
      return await this.#navigateOnPage(page, url)
    } catch (error) {
      await page.close().catch(() => undefined)
      throw error
    }
  }

  async #navigateOnPage(page: Page, rawUrl: string): Promise<{ page: Page; info: BrowserPageInfo }> {
    await this.#policy.assertPinnedUrl(rawUrl, this.#target)
    this.#policyError = undefined
    this.#downloadDetected = false
    const document = await this.#documentFetcher({ policy: this.#policy, target: this.#target, url: rawUrl })
    try {
      // The only network-capable operation is the host-side fetch above. The
      // browser receives an already bounded document and is used only for DOM
      // text extraction and screenshot rendering.
      await page.setContent(decodeDocument(document.body), {
        timeout: this.#policy.limits.timeoutMs,
        waitUntil: 'domcontentloaded',
      })
    } catch (error) {
      if (this.#policyError !== undefined) throw this.#policyError
      if (isPlaywrightTimeout(error)) throw new BrowserPolicyError('timeout', '浏览器离线渲染超时')
      throw new BrowserClientError('navigation', '浏览器离线渲染失败', { cause: error })
    }
    if (this.#policyError !== undefined) throw this.#policyError
    if (this.#downloadDetected) throw new BrowserClientError('download', '浏览器已阻止下载')
    let title: string
    try {
      title = cleanText(await page.title(), 240)
    } catch (error) {
      if (this.#policyError !== undefined) throw this.#policyError
      throw new BrowserClientError('navigation', '浏览器离线页面状态已改变', { cause: error })
    }
    if (this.#policyError !== undefined) throw this.#policyError
    return {
      page,
      info: {
        url: document.url,
        title,
        statusCode: document.statusCode,
      },
    }
  }

  async #newPage(): Promise<Page> {
    const page = await this.#context.newPage()
    if (this.#mainPage === undefined || this.#mainPage.isClosed()) this.#mainPage = page
    page.once('close', () => {
      if (this.#mainPage === page) this.#mainPage = undefined
    })
    page.on('download', (download) => {
      this.#downloadDetected = true
      void download.cancel().catch(() => undefined)
    })
    page.setDefaultTimeout(this.#policy.limits.timeoutMs)
    return page
  }

  async #installGuards(): Promise<void> {
    await this.#context.route('**/*', async (route, request) => {
      try {
        // Check the method before classifying the resource. This keeps a
        // POST/PUT/DELETE from being silently treated as an ordinary blocked
        // image or frame request.
        this.#policy.assertReadOnlyRequest(request.method(), request.resourceType())
        if (request.resourceType() === 'document') {
          // setContent() receives the one bounded document fetched by the host.
          // A meta refresh, link navigation or frame document must never open a
          // second Chromium network path around the pinned transport.
          this.#policyError = new BrowserPolicyError('non-readonly-request', '浏览器离线渲染期间的页面跳转已被阻止')
        }
        // Static V1 deliberately omits every subresource. All browser-side
        // requests are blocked; the host-side pinned fetch is the sole network
        // authority for the action.
        await route.abort('blockedbyclient').catch(() => undefined)
      } catch (error) {
        this.#policyError = error instanceof BrowserPolicyError
          ? error
          : new BrowserPolicyError('invalid-url', '浏览器请求已被安全策略阻止')
        await route.abort('blockedbyclient').catch(() => undefined)
      }
    })
    await this.#context.routeWebSocket('**/*', (webSocket) => {
      this.#policyError = new BrowserPolicyError('non-readonly-request', '浏览器 WebSocket 通道已禁用')
      webSocket.close()
    })
    this.#context.on('page', (page) => {
      if (this.#mainPage === undefined || this.#mainPage.isClosed()) {
        this.#mainPage = page
        return
      }
      if (page === this.#mainPage) return
      this.#policyError = new BrowserPolicyError('non-readonly-request', '浏览器弹出页面已禁用')
      void page.close().catch(() => undefined)
    })
  }
}

/**
 * Fetches one same-host document at a time with a fixed address. Redirects
 * never trigger a fresh DNS lookup; they reuse the address selected by
 * BrowserPolicy.resolveTarget and are checked against the original hostname.
 */
export async function fetchPinnedDocument(input: BrowserDocumentFetcherInput, requester: BrowserPinnedRequester = requestPinnedResponse): Promise<BrowserFetchedDocument> {
  let current = input.policy.assertPinnedUrl(input.url, input.target)
  let redirectCount = 0
  while (true) {
    const response = await requester({ policy: input.policy, target: input.target, url: current })
    let bodyConsumed = false
    try {
      if (response.remoteAddress === undefined) {
        throw new BrowserPolicyError('peer-mismatch', '网页响应未提供远端连接地址')
      }
      input.policy.assertConnectedAddress(response.remoteAddress, input.target.pinnedAddress)

      const location = response.headers.location
      if (isRedirectStatus(response.statusCode) && location !== undefined) {
        input.policy.assertRedirectDepth(redirectCount + 1)
        const redirected = input.policy.assertPinnedUrl(new URL(location, current).toString(), input.target)
        redirectCount += 1
        current = redirected
        continue
      }
      if (/\battachment\b/iu.test(response.headers['content-disposition'] ?? '')) {
        throw new BrowserClientError('download', '浏览器已阻止导航下载')
      }
      const body = await readBoundedDocumentBody(response, input.policy)
      bodyConsumed = true
      return {
        url: current.toString(),
        statusCode: response.statusCode,
        headers: response.headers,
        body,
      }
    } finally {
      // Redirects and every early failure are discarded without buffering. On
      // the normal document path the stream was fully consumed already.
      if (!bodyConsumed || (response.headers.location !== undefined && isRedirectStatus(response.statusCode))) response.cancel()
    }
  }
}

/** Reads an async response stream and destroys it immediately at the byte cap. */
export async function readBoundedDocumentBody(response: BrowserPinnedResponse, policy: BrowserPolicy): Promise<Buffer> {
  const declaredLength = response.headers['content-length']
  if (declaredLength !== undefined && /^\d+$/u.test(declaredLength)) policy.assertResponseBytes(Number(declaredLength))

  const timeoutError = new BrowserPolicyError('timeout', '网页响应读取超时')
  try {
    return await withTimeout(async () => {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        total += buffer.byteLength
        if (total > policy.limits.maxResponseBytes) {
          const error = new BrowserPolicyError('too-large', '网页响应超过大小限制')
          response.cancel(error)
          throw error
        }
        chunks.push(buffer)
      }
      policy.assertResponseBytes(total)
      return Buffer.concat(chunks, total)
    }, policy.limits.timeoutMs, () => response.cancel(timeoutError), timeoutError)
  } catch (error) {
    response.cancel(error instanceof Error ? error : undefined)
    if (error instanceof BrowserPolicyError || error instanceof BrowserClientError) throw error
    throw new BrowserClientError('outcome-unknown', '网页响应结果未确定', { cause: error })
  }
}

function requestPinnedResponse(input: BrowserPinnedRequestInput): Promise<BrowserPinnedResponse> {
  const url = input.url
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  const fixedAddress = input.target.pinnedAddress
  const family = isIP(fixedAddress)
  const requestOptions = {
    protocol: url.protocol,
    hostname: input.target.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    path: `${url.pathname || '/'}${url.search}`,
    method: 'GET',
    headers: {
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-store',
      Host: url.host,
    },
    agent: false,
    autoSelectFamily: false,
    lookup: (_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      callback(null, fixedAddress, family)
    },
    ...(url.protocol === 'https:' ? { servername: input.target.hostname } : {}),
  }

  return new Promise<BrowserPinnedResponse>((resolve, reject) => {
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let settled = false
    let peerVerified = false
    let peerTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => fail(new BrowserPolicyError('timeout', '网页请求超时')), input.policy.limits.timeoutMs)

    const clearTimers = () => {
      clearTimeout(timeout)
      if (peerTimer !== undefined) clearTimeout(peerTimer)
    }
    const cancel = (reason?: Error) => {
      const error = reason instanceof Error ? reason : undefined
      response?.destroy(error)
      request?.destroy(error)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimers()
      cancel(error instanceof Error ? error : undefined)
      if (error instanceof BrowserPolicyError || error instanceof BrowserClientError) reject(error)
      else reject(new BrowserClientError('outcome-unknown', '网页请求结果未确定', { cause: error }))
    }
    const verifyPeer = (socket: { remoteAddress: string | undefined }) => {
      if (settled) return
      if (socket.remoteAddress === undefined) return
      try {
        input.policy.assertConnectedAddress(socket.remoteAddress, fixedAddress)
      } catch (error) {
        fail(error)
        return
      }
      peerVerified = true
      if (peerTimer !== undefined) clearTimeout(peerTimer)
    }

    try {
      request = requestFn(requestOptions, (incoming) => {
        response = incoming
        verifyPeer(incoming.socket)
        if (settled) return
        clearTimeout(timeout)
        if (peerTimer !== undefined) clearTimeout(peerTimer)
        settled = true
        resolve({
          statusCode: incoming.statusCode ?? 0,
          headers: normalizeHeaders(incoming.headers),
          ...(incoming.socket.remoteAddress === undefined ? {} : { remoteAddress: incoming.socket.remoteAddress }),
          body: incoming,
          cancel,
        })
      })
      request.on('error', (error) => {
        if (!settled) fail(error)
      })
      request.setTimeout(input.policy.limits.timeoutMs, () => fail(new BrowserPolicyError('timeout', '网页请求超时')))
      if (!peerVerified) peerTimer = setTimeout(() => fail(new BrowserPolicyError('peer-timeout', '网页远端连接校验超时')), input.policy.limits.peerTimeoutMs)
      request.on('socket', (socket: import('node:net').Socket) => {
        socket.once('connect', () => verifyPeer(socket))
        socket.once('secureConnect', () => verifyPeer(socket))
        if (!socket.connecting) verifyPeer(socket)
      })
      request.end()
    } catch (error) {
      fail(error)
    }
  })
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') normalized[key.toLowerCase()] = value
    else if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(', ')
  }
  return normalized
}

async function withTimeout<T>(work: () => Promise<T>, timeoutMs: number, onTimeout: () => void, timeoutError: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout()
          reject(timeoutError)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400
}

function decodeDocument(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function cleanText(value: string, maximum: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || /timeout/iu.test(error.message))
}
