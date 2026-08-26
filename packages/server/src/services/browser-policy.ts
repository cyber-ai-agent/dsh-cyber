import { isIP } from 'node:net'
import { Worker } from 'node:worker_threads'

export interface BrowserPolicyLimits {
  timeoutMs: number
  dnsTimeoutMs: number
  peerTimeoutMs: number
  maxRedirects: number
  maxResponseBytes: number
  maxTextChars: number
  maxScreenshotBytes: number
  maxScreenshotWidth: number
  maxScreenshotHeight: number
}

export interface BrowserPolicyOptions extends Partial<BrowserPolicyLimits> {
  resolveHostname?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>
}

export type BrowserPolicyErrorKind =
  | 'invalid-url'
  | 'non-readonly-request'
  | 'private-address'
  | 'dns-failed'
  | 'dns-timeout'
  | 'peer-mismatch'
  | 'peer-timeout'
  | 'too-many-redirects'
  | 'too-large'
  | 'timeout'
  | 'invalid-selector'
  | 'invalid-viewport'

export class BrowserPolicyError extends Error {
  constructor(readonly kind: BrowserPolicyErrorKind, message: string) {
    super(message)
    this.name = 'BrowserPolicyError'
  }
}

const DEFAULT_LIMITS: BrowserPolicyLimits = {
  timeoutMs: 15_000,
  dnsTimeoutMs: 2_000,
  peerTimeoutMs: 2_000,
  maxRedirects: 8,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTextChars: 200_000,
  maxScreenshotBytes: 4 * 1024 * 1024,
  maxScreenshotWidth: 1_920,
  maxScreenshotHeight: 1_080,
}

/**
 * Browser egress policy. URL syntax is checked before approval, while DNS is
 * intentionally checked only by the executing client so merely proposing a
 * Browser action cannot cause network access.
 */
export class BrowserPolicy {
  readonly limits: BrowserPolicyLimits
  readonly #resolveHostname: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>

  constructor(options: BrowserPolicyOptions = {}) {
    this.limits = {
      timeoutMs: bounded(options.timeoutMs, DEFAULT_LIMITS.timeoutMs, 250, 120_000),
      dnsTimeoutMs: bounded(options.dnsTimeoutMs, DEFAULT_LIMITS.dnsTimeoutMs, 100, 10_000),
      peerTimeoutMs: bounded(options.peerTimeoutMs, DEFAULT_LIMITS.peerTimeoutMs, 100, 10_000),
      maxRedirects: bounded(options.maxRedirects, DEFAULT_LIMITS.maxRedirects, 0, 20),
      maxResponseBytes: bounded(options.maxResponseBytes, DEFAULT_LIMITS.maxResponseBytes, 16 * 1024, 32 * 1024 * 1024),
      maxTextChars: bounded(options.maxTextChars, DEFAULT_LIMITS.maxTextChars, 256, 2_000_000),
      maxScreenshotBytes: bounded(options.maxScreenshotBytes, DEFAULT_LIMITS.maxScreenshotBytes, 64 * 1024, 16 * 1024 * 1024),
      maxScreenshotWidth: bounded(options.maxScreenshotWidth, DEFAULT_LIMITS.maxScreenshotWidth, 320, 3_840),
      maxScreenshotHeight: bounded(options.maxScreenshotHeight, DEFAULT_LIMITS.maxScreenshotHeight, 240, 2_160),
    }
    this.#resolveHostname = options.resolveHostname ?? resolveHostname
  }

  validateUrl(value: string): URL {
    if (typeof value !== 'string' || value.trim() === '') throw new BrowserPolicyError('invalid-url', '浏览器地址不能为空')
    let url: URL
    try { url = new URL(value.trim()) } catch { throw new BrowserPolicyError('invalid-url', '浏览器地址无效') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BrowserPolicyError('invalid-url', '浏览器仅接受 HTTP(S) 地址')
    }
    if (!url.hostname || url.username || url.password || url.hash) {
      throw new BrowserPolicyError('invalid-url', '浏览器地址不能包含凭据或片段')
    }
    if (isBlockedHost(url.hostname)) throw new BrowserPolicyError('private-address', '浏览器不能访问本机或私有网络地址')
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(key)) throw new BrowserPolicyError('invalid-url', '浏览器地址不能包含敏感查询参数')
    }
    return url
  }

  async resolveTarget(value: string): Promise<BrowserResolvedTarget> {
    const url = this.validateUrl(value)
    const hostname = normalizeHost(url.hostname)
    const dnsAbort = new AbortController()
    const addresses = isIP(hostname) === 0
      ? await withTimeout(this.#resolveHostname(hostname, dnsAbort.signal), this.limits.dnsTimeoutMs, 'dns-timeout', () => dnsAbort.abort())
        .catch((error) => {
          if (error instanceof BrowserPolicyError) throw error
          throw new BrowserPolicyError('dns-failed', '浏览器无法解析公开主机')
        })
      : [hostname]
    if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
      throw new BrowserPolicyError('private-address', '浏览器主机解析到了本机或私有网络地址')
    }
    const publicAddresses = addresses.filter((address) => isIP(normalizeHost(address)) !== 0).sort(compareAddresses)
    const pinnedAddress = publicAddresses[0]
    if (pinnedAddress === undefined) throw new BrowserPolicyError('dns-failed', '浏览器 DNS 未返回公开地址')
    return { url: url.toString(), hostname, pinnedAddress: normalizeHost(pinnedAddress) }
  }

  async assertPublicUrl(value: string): Promise<URL> {
    return new URL((await this.resolveTarget(value)).url)
  }

  assertPinnedUrl(value: string, target: BrowserResolvedTarget): URL {
    const url = this.validateUrl(value)
    if (normalizeHost(url.hostname) !== target.hostname) {
      throw new BrowserPolicyError('invalid-url', '浏览器重定向和子资源必须留在原始主机')
    }
    return url
  }

  async assertPinnedRequestUrl(value: string, target: BrowserResolvedTarget, redirectDepth: number): Promise<URL> {
    this.assertRedirectDepth(redirectDepth)
    return this.assertPinnedUrl(value, target)
  }

  async assertRequestUrl(value: string, redirectDepth: number): Promise<URL> {
    this.assertRedirectDepth(redirectDepth)
    return this.assertPublicUrl(value)
  }

  assertRedirectDepth(depth: number): void {
    if (!Number.isSafeInteger(depth) || depth > this.limits.maxRedirects) {
      throw new BrowserPolicyError('too-many-redirects', '浏览器重定向次数超过限制')
    }
  }

  assertReadOnlyRequest(method: string, resourceType: string): void {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new BrowserPolicyError('non-readonly-request', '浏览器只允许 GET 和 HEAD 请求')
    }
    if (resourceType === 'websocket' || resourceType === 'eventsource') {
      throw new BrowserPolicyError('non-readonly-request', '浏览器 WebSocket 和 EventSource 通道已禁用')
    }
  }

  assertResponseBytes(byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.limits.maxResponseBytes) {
      throw new BrowserPolicyError('too-large', '浏览器响应超过大小限制')
    }
  }

  assertConnectedAddress(address: string, pinnedAddress: string): void {
    if (isBlockedAddress(address) || !sameIp(address, pinnedAddress)) {
      throw new BrowserPolicyError('peer-mismatch', '浏览器实际连接地址与固定公开地址不一致')
    }
  }

  assertText(text: string): string {
    if (text.length > this.limits.maxTextChars) {
      throw new BrowserPolicyError('too-large', '浏览器可见文本超过大小限制')
    }
    return text
  }

  assertSelector(selector: string): string {
    const normalized = typeof selector === 'string' ? selector.trim() : ''
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new BrowserPolicyError('invalid-selector', '浏览器选择器无效')
    }
    return normalized
  }

  assertViewport(width: number | undefined, height: number | undefined): { width: number; height: number } {
    const normalizedWidth = width ?? 1_280
    const normalizedHeight = height ?? 720
    if (!Number.isSafeInteger(normalizedWidth) || !Number.isSafeInteger(normalizedHeight)
      || normalizedWidth < 320 || normalizedHeight < 240
      || normalizedWidth > this.limits.maxScreenshotWidth || normalizedHeight > this.limits.maxScreenshotHeight) {
      throw new BrowserPolicyError('invalid-viewport', '浏览器截图视口超过大小限制')
    }
    return { width: normalizedWidth, height: normalizedHeight }
  }
}

export interface BrowserResolvedTarget {
  url: string
  hostname: string
  pinnedAddress: string
}

const SENSITIVE_QUERY_KEY = /(?:token|key|secret|signature|auth|password|cookie|session|api[-_]?key|access[-_]?token)/iu

export function isBlockedHost(value: string): boolean {
  const host = normalizeHost(value).toLowerCase()
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'localhost.localdomain'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
  ) return true
  return isBlockedAddress(host)
}

export function isBlockedAddress(value: string): boolean {
  const host = normalizeHost(value).toLowerCase()
  const kind = isIP(host)
  if (kind === 4) return isBlockedIpv4(host)
  if (kind === 6) return isBlockedIpv6(host)
  return false
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, kind: 'dns-timeout' | 'peer-timeout', onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new BrowserPolicyError(kind, kind === 'dns-timeout' ? '浏览器 DNS 解析超时' : '浏览器连接地址校验超时'))
          onTimeout?.()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function resolveHostname(hostname: string, signal?: AbortSignal): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolve, reject) => {
    const worker = new Worker(`
      const { lookup } = require('node:dns');
      const { parentPort, workerData } = require('node:worker_threads');
      lookup(workerData, { all: true, verbatim: true }, (error, addresses) => {
        if (error) parentPort.postMessage({ error: { code: error.code, message: error.message } });
        else parentPort.postMessage({ addresses: addresses.map((item) => item.address) });
      });
    `, { eval: true, workerData: hostname })
    let settled = false
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      worker.removeAllListeners()
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      void worker.terminate()
      callback()
    }
    const abort = () => finish(() => reject(signal?.reason ?? new Error('DNS resolution aborted')))
    if (signal?.aborted === true) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('message', (message: { addresses?: string[]; error?: { code?: string; message?: string } }) => {
      if (message.error !== undefined) {
        const error = new Error(message.error.message ?? 'DNS lookup failed') as NodeJS.ErrnoException
        error.code = message.error.code
        finish(() => reject(error))
        return
      }
      finish(() => resolve(message.addresses ?? []))
    })
    worker.once('error', (error) => finish(() => reject(error)))
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`DNS worker exited with code ${code}`)))
    })
  })
}

function compareAddresses(left: string, right: string): number {
  const leftKind = isIP(normalizeHost(left))
  const rightKind = isIP(normalizeHost(right))
  if (leftKind !== rightKind) return leftKind === 4 ? -1 : 1
  return normalizeHost(left).localeCompare(normalizeHost(right))
}

function sameIp(left: string, right: string): boolean {
  const leftHost = normalizeHost(left)
  const rightHost = normalizeHost(right)
  if (leftHost === rightHost) return true
  const leftWords = parseIpv6(leftHost)
  const rightWords = parseIpv6(rightHost)
  return leftWords !== undefined && rightWords !== undefined && leftWords.every((word, index) => word === rightWords[index])
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function isBlockedIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return true
  const octets = match.slice(1).map(Number)
  if (octets.some((item) => item > 255)) return true
  const first = octets[0]!
  const second = octets[1]!
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0)
    || (first === 192 && second === 2)
    || (first === 198 && second >= 18 && second <= 19)
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first >= 224
}

function isBlockedIpv6(value: string): boolean {
  const words = parseIpv6(value)
  if (words === undefined) return true
  const allZero = words.every((word) => word === 0)
  if (allZero || (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)) return true
  if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80
    || (words[0]! & 0xffc0) === 0xfec0 || (words[0]! & 0xff00) === 0xff00) return true
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    return isBlockedIpv4(`${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`)
  }
  return false
}

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
