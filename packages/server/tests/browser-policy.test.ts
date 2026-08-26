import { describe, expect, it } from 'vitest'

import { BrowserPolicy, BrowserPolicyError, isBlockedAddress, isBlockedHost } from '../src/services/browser-policy.js'

describe('BrowserPolicy', () => {
  it('rejects non-http schemes and local/private/link-local targets', () => {
    const policy = new BrowserPolicy({ resolveHostname: async () => ['93.184.216.34'] })
    for (const value of [
      'file:///C:/secret.txt',
      'data:text/html,secret',
      'javascript:alert(1)',
      'http://localhost:43123',
      'http://127.0.0.1:43123',
      'http://0177.0.0.1',
      'http://0x7f000001',
      'http://2130706433',
      'http://127.1',
      'http://10.0.0.8',
      'http://192.168.1.10',
      'http://169.254.169.254',
      'http://[::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[::127.0.0.1]',
      'http://[fd00::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[::ffff:7f00:1]',
      'https://example.com/?access_token=secret',
    ]) {
      expect(() => policy.validateUrl(value)).toThrow(BrowserPolicyError)
    }
    expect(isBlockedHost('service.local')).toBe(true)
    expect(isBlockedAddress('100.64.0.1')).toBe(true)
    expect(isBlockedAddress('93.184.216.34')).toBe(false)
  })

  it('re-resolves every public host check and blocks DNS answers in private ranges', async () => {
    const resolutions: string[] = []
    const policy = new BrowserPolicy({
      resolveHostname: async (hostname) => {
        resolutions.push(hostname)
        return hostname === 'public.example' ? ['93.184.216.34'] : ['127.0.0.1']
      },
    })
    const target = await policy.resolveTarget('https://public.example/page')
    await expect(policy.assertPublicUrl('https://public.example/page')).resolves.toMatchObject({ hostname: 'public.example' })
    await expect(policy.assertPinnedRequestUrl('https://public.example/next', target, 1)).resolves.toBeInstanceOf(URL)
    await expect(policy.assertPinnedRequestUrl('https://other.example/redirect', target, 1)).rejects.toMatchObject({ kind: 'invalid-url' })
    await expect(policy.assertPublicUrl('https://rebind.example/redirect')).rejects.toMatchObject({ kind: 'private-address' })
    expect(resolutions).toEqual(['public.example', 'public.example', 'rebind.example'])
  })

  it('rejects mapped private IPv6 answers returned by DNS', async () => {
    const mapped = new BrowserPolicy({ resolveHostname: async () => ['::ffff:127.0.0.1'] })
    await expect(mapped.resolveTarget('https://public.example')).rejects.toMatchObject({ kind: 'private-address' })
  })

  it('fails closed when DNS resolution exceeds its hard timeout', async () => {
    let aborted = false
    const policy = new BrowserPolicy({
      dnsTimeoutMs: 100,
      resolveHostname: (_hostname, signal) => new Promise<readonly string[]>(() => {
        signal?.addEventListener('abort', () => { aborted = true }, { once: true })
      }),
    })
    await expect(policy.resolveTarget('https://slow.example')).rejects.toMatchObject({ kind: 'dns-timeout' })
    expect(aborted).toBe(true)
  })

  it('revalidates the destination on each redirect instead of trusting the first host', async () => {
    const policy = new BrowserPolicy({
      resolveHostname: async (hostname) => hostname === 'public.example' ? ['93.184.216.34'] : ['10.0.0.8'],
    })
    await expect(policy.assertRequestUrl('https://public.example/start', 0)).resolves.toBeInstanceOf(URL)
    await expect(policy.assertRequestUrl('https://redirected.example/private', 1)).rejects.toMatchObject({ kind: 'private-address' })
  })

  it('bounds redirects, response/text sizes, selectors and screenshot viewports', () => {
    const policy = new BrowserPolicy({
      maxRedirects: 1,
      maxResponseBytes: 16 * 1024,
      maxTextChars: 256,
      maxScreenshotWidth: 800,
      maxScreenshotHeight: 600,
    })
    expect(() => policy.assertRedirectDepth(2)).toThrow('重定向次数')
    expect(() => policy.assertResponseBytes(16 * 1024 + 1)).toThrow('大小限制')
    expect(() => policy.assertConnectedAddress('127.0.0.1', '93.184.216.34')).toThrow('固定公开')
    expect(() => policy.assertText('x'.repeat(257))).toThrow('文本超过')
    expect(() => policy.assertSelector('')).toThrow('选择器')
    expect(() => policy.assertViewport(801, 600)).toThrow('截图视口')
    expect(policy.assertViewport(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it('allows only read-only HTTP methods and blocks streaming channels', () => {
    const policy = new BrowserPolicy()
    expect(() => policy.assertReadOnlyRequest('GET', 'document')).not.toThrow()
    expect(() => policy.assertReadOnlyRequest('HEAD', 'fetch')).not.toThrow()
    expect(() => policy.assertReadOnlyRequest('POST', 'fetch')).toThrow('GET 和 HEAD')
    expect(() => policy.assertReadOnlyRequest('GET', 'websocket')).toThrow('WebSocket')
    expect(() => policy.assertReadOnlyRequest('GET', 'eventsource')).toThrow('EventSource')
  })
})
