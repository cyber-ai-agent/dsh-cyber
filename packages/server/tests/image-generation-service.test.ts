import { describe, expect, it, vi } from 'vitest'

import { ImageGenerationService, isImageGenerationModel, sniffImageMime } from '../src/services/image-generation-service.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('image generation service', () => {
  it('recognizes image mode from the manual mark and from image-only outputs', () => {
    expect(isImageGenerationModel({ settings: { imageGeneration: true } })).toBe(true)
    expect(isImageGenerationModel({ settings: { outputTypes: ['image'] } })).toBe(true)
    // A model that also speaks text stays a conversation model.
    expect(isImageGenerationModel({ settings: { outputTypes: ['image', 'text'] } })).toBe(false)
    expect(isImageGenerationModel({ settings: {} })).toBe(false)
  })

  it('detects png/jpeg/webp by signature and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    expect(sniffImageMime(webp)).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBeUndefined()
  })

  it('posts to the images endpoint under the configured base url and returns inline bytes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://gateway.example.com/v1/images/generations')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'wan2.7-image', prompt: '画一只猫', n: 1 })
      return jsonResponse({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: '一只猫' }] })
    })
    const service = new ImageGenerationService({ fetch: fetchMock as never })
    const result = await service.generate({ baseUrl: 'https://gateway.example.com/v1', apiKey: 'sk-x', model: 'wan2.7-image', prompt: '画一只猫' })
    expect(result.mimeType).toBe('image/png')
    expect(result.revisedPrompt).toBe('一只猫')
    const headers = (fetchMock.mock.calls[0] as [unknown, RequestInit])[1].headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-x')
  })

  it('downloads an https url response and refuses a cross-origin http one', async () => {
    const service = new ImageGenerationService({
      fetch: vi.fn<typeof fetch>(async (url) => String(url).endsWith('/images/generations')
        ? jsonResponse({ data: [{ url: 'https://cdn.example.com/gen.png' }] })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } })) as never,
    })
    await expect(service.generate({ baseUrl: 'https://gw.example.com/v1', model: 'm', prompt: 'p' })).resolves.toMatchObject({ mimeType: 'image/png' })

    const evil = new ImageGenerationService({
      fetch: vi.fn<typeof fetch>(async (url) => String(url).endsWith('/images/generations')
        ? jsonResponse({ data: [{ url: 'http://169.254.169.254/latest/meta' }] })
        : new Response(PNG)) as never,
    })
    await expect(evil.generate({ baseUrl: 'https://gw.example.com/v1', model: 'm', prompt: 'p' })).rejects.toMatchObject({ code: 'image_url_insecure' })
  })

  it('does not follow redirects on authenticated image requests', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect((init as RequestInit).redirect).toBe('error')
      return String(url).endsWith('/images/generations')
        ? jsonResponse({ data: [{ b64_json: PNG.toString('base64') }] })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } })
    })
    await expect(new ImageGenerationService({ fetch: fetchMock as never }).generate({
      baseUrl: 'https://gw.example.com/v1',
      apiKey: 'sk-x',
      model: 'm',
      prompt: 'p',
    })).resolves.toMatchObject({ mimeType: 'image/png' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps status codes to distinct Chinese outcomes and keeps the http status', async () => {
    const service = new ImageGenerationService({ fetch: vi.fn<typeof fetch>(async () => jsonResponse({ error: 'slow down' }, 429)) as never })
    await expect(service.generate({ baseUrl: 'https://gw.example.com/v1', model: 'm', prompt: 'p' }))
      .rejects.toMatchObject({ code: 'image_rate_limited', httpStatus: 429 })
    const auth = new ImageGenerationService({ fetch: vi.fn<typeof fetch>(async () => jsonResponse({}, 401)) as never })
    await expect(auth.generate({ baseUrl: 'https://gw.example.com/v1', model: 'm', prompt: 'p' }))
      .rejects.toMatchObject({ code: 'image_auth_failed' })
  })

  it('refuses to pass off non-image bytes as a picture', async () => {
    const service = new ImageGenerationService({
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })) as never,
    })
    await expect(service.generate({ baseUrl: 'https://gw.example.com/v1', model: 'm', prompt: 'p' }))
      .rejects.toMatchObject({ code: 'image_signature_unknown' })
  })
})
