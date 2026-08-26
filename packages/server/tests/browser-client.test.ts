import { describe, expect, it } from 'vitest'

import {
  fetchPinnedDocument,
  type BrowserPinnedResponse,
} from '../src/integrations/browser-client.js'
import { BrowserPolicy } from '../src/services/browser-policy.js'

describe('pinned Browser document transport', () => {
  it('destroys a chunked response as soon as the streaming byte cap is crossed', async () => {
    const policy = new BrowserPolicy({ maxResponseBytes: 16 * 1024 })
    let yielded = 0
    let cancelled = false
    const response = responseFor(async function* () {
      yielded += 1
      yield Buffer.alloc(8 * 1024, 1)
      yielded += 1
      yield Buffer.alloc(8 * 1024, 2)
      yielded += 1
      yield Buffer.from('overflow')
      yielded += 1
      yield Buffer.from('must not be consumed')
    }, () => { cancelled = true })

    await expect(fetchPinnedDocument({
      policy,
      target: target(),
      url: 'https://example.com/chunked',
    }, async () => response)).rejects.toMatchObject({ kind: 'too-large' })
    expect(cancelled).toBe(true)
    expect(yielded).toBe(3)
  })

  it('follows same-host redirects while reusing the pinned public address', async () => {
    const requested: string[] = []
    const responseForRequest = async ({ url }: { url: URL; policy: BrowserPolicy; target: ReturnType<typeof target> }): Promise<BrowserPinnedResponse> => {
      requested.push(url.toString())
      if (requested.length === 1) return responseFor(async function* () { yield Buffer.from('discarded') }, () => undefined, { statusCode: 302, headers: { location: '/final' } })
      return responseFor(async function* () { yield Buffer.from('<title>Example</title>ok') })
    }

    const document = await fetchPinnedDocument({
      policy: new BrowserPolicy({ maxRedirects: 1 }),
      target: target(),
      url: 'https://example.com/start',
    }, responseForRequest)

    expect(requested).toEqual(['https://example.com/start', 'https://example.com/final'])
    expect(document.url).toBe('https://example.com/final')
    expect(document.body.toString()).toContain('Example')
  })

  it('rejects a cross-host redirect before requesting the second host', async () => {
    let calls = 0
    let cancelled = false
    await expect(fetchPinnedDocument({
      policy: new BrowserPolicy(),
      target: target(),
      url: 'https://example.com/start',
    }, async () => {
      calls += 1
      return responseFor(async function* () { yield Buffer.from('discarded') }, () => { cancelled = true }, { statusCode: 302, headers: { location: 'https://other.example/private' } })
    })).rejects.toMatchObject({ kind: 'invalid-url' })
    expect(calls).toBe(1)
    expect(cancelled).toBe(true)
  })

  it('cancels a response that stalls beyond the hard body timeout', async () => {
    let cancelled = false
    await expect(fetchPinnedDocument({
      policy: new BrowserPolicy({ timeoutMs: 250 }),
      target: target(),
      url: 'https://example.com/slow',
    }, async () => responseFor(async function* () {
      yield Buffer.from('partial')
      await new Promise<void>(() => undefined)
    }, () => { cancelled = true }))).rejects.toMatchObject({ kind: 'timeout' })
    expect(cancelled).toBe(true)
  })

  it('fails closed when the connected peer is not the selected public address', async () => {
    let cancelled = false
    await expect(fetchPinnedDocument({
      policy: new BrowserPolicy(),
      target: target(),
      url: 'https://example.com/peer',
    }, async () => responseFor(async function* () { yield Buffer.from('must not read') }, () => { cancelled = true }, { remoteAddress: '93.184.216.35' }))).rejects.toMatchObject({ kind: 'peer-mismatch' })
    expect(cancelled).toBe(true)
  })

  it.runIf(process.env.BROWSER_NETWORK_TESTS === '1')('still reads the real example.com document through the pinned transport', async () => {
    const policy = new BrowserPolicy()
    const target = await policy.resolveTarget('https://example.com/')
    const document = await fetchPinnedDocument({ policy, target, url: 'https://example.com/' })
    expect(document.statusCode).toBe(200)
    expect(document.body.toString('utf8')).toMatch(/example domain/iu)
  })
})

function responseFor(
  body: () => AsyncIterable<Uint8Array>,
  cancel: () => void = () => undefined,
  options: Partial<Pick<BrowserPinnedResponse, 'statusCode' | 'headers' | 'remoteAddress'>> = {},
): BrowserPinnedResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers ?? {},
    remoteAddress: options.remoteAddress ?? '93.184.216.34',
    body: body(),
    cancel,
  }
}

function target() {
  return { url: 'https://example.com/', hostname: 'example.com', pinnedAddress: '93.184.216.34' }
}
