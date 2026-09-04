import type { ModelProfile } from '@dsh-cyber/contracts'

import { ServiceError } from './service-error.js'

/**
 * Calls an OpenAI-compatible image endpoint (`POST {baseUrl}/images/generations`)
 * and returns verified image bytes.
 *
 * This is deliberately its own client rather than a chat-completion retry in
 * a costume: image models reject conversational requests (the usage log shows
 * context-window and invalid-request errors from exactly that), and the
 * response shape (data[0].b64_json | url) is not a message. Timeouts are
 * generous because image generation genuinely takes minutes on busy gateways.
 */

export type GeneratedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ImageGenerationResult {
  bytes: Buffer
  mimeType: GeneratedImageMimeType
  revisedPrompt?: string
}

export interface ImageGenerationRequest {
  baseUrl: string
  apiKey?: string
  model: string
  prompt: string
  size?: string
}

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_IMAGE_BODY_BYTES = 40 * 1024 * 1024

/**
 * A profile runs in image mode when its declared output is image-only, or the
 * owner marked it explicitly - gateways that hide modalities behind a generic
 * custom connection still need the honest manual switch.
 */
export function isImageGenerationModel(profile: Pick<ModelProfile, 'settings'>): boolean {
  if (profile.settings.imageGeneration === true) return true
  const output = Array.isArray(profile.settings.outputTypes)
    ? (profile.settings.outputTypes as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  return output.includes('image') && !output.includes('text')
}

export interface ImageGenerationServiceOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export class ImageGenerationService {
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: ImageGenerationServiceOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async generate(input: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const endpoint = endpointFor(input.baseUrl)
    const body = JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      n: 1,
      ...(input.size === undefined ? {} : { size: input.size }),
      // Ask for inline bytes first: a returned URL may be unreachable from
      // this machine even when the gateway itself can serve it.
      response_format: 'b64_json',
    })
    const json = await this.#request(endpoint, input, body)
    const items = Array.isArray(json.data) ? json.data : []
    const first = items.find((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    if (first === undefined) throw new ServiceError('unavailable', 'image_response_empty', '图像服务没有返回任何图片。')
    const revisedPrompt = typeof first.revised_prompt === 'string' ? first.revised_prompt : undefined
    if (typeof first.b64_json === 'string' && first.b64_json.length > 0) {
      return finish(Buffer.from(first.b64_json, 'base64'), revisedPrompt)
    }
    if (typeof first.url === 'string' && first.url.length > 0) {
      return finish(await this.#fetchImageBytes(first.url, endpoint), revisedPrompt)
    }
    throw new ServiceError('unavailable', 'image_response_empty', '图像服务的响应里没有可用的图片数据（既无 b64_json 也无 url）。')
  }

  async #request(endpoint: URL, input: ImageGenerationRequest, body: string): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.#fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(input.apiKey === undefined ? {} : { authorization: `Bearer ${input.apiKey}` }),
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
        // A provider endpoint is already validated, but it must not be able to
        // redirect an authenticated request to a different host.
        redirect: 'error',
      })
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      if (timedOut) throw new ServiceError('unavailable', 'image_generation_timeout', `图像生成超过 ${Math.round(this.#timeoutMs / 1000)} 秒未完成，网关可能在排队，可稍后重试。`)
      throw new ServiceError('unavailable', 'image_network_error', '无法连接图像生成服务，请检查服务商地址与网络。')
    }
    const text = await readCappedText(response)
    if (!response.ok) {
      const hint = text.slice(0, 160)
      const code = response.status === 401 || response.status === 403 ? 'image_auth_failed'
        : response.status === 404 ? 'image_model_not_found'
        : response.status === 429 ? 'image_rate_limited'
        : response.status >= 500 ? 'image_upstream_error' : 'image_request_rejected'
      const message = response.status === 401 || response.status === 403 ? `图像服务拒绝了该密钥（HTTP ${response.status}），请在服务商编辑中确认密钥。`
        : response.status === 404 ? `图像模型「${input.model}」不存在或该密钥无权限（HTTP 404）。`
        : response.status === 429 ? '图像服务限流（HTTP 429），稍后再试。'
        : response.status >= 500 ? `图像上游服务异常（HTTP ${response.status}）。`
        : `图像请求被拒绝（HTTP ${response.status}）。`
      throw new ServiceError(response.status >= 500 ? 'unavailable' : response.status === 429 ? 'rate-limited' : 'invalid', code, message + (hint.length > 0 ? ` 服务商说明：${hint}` : ''), response.status)
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      return parsed as Record<string, unknown>
    } catch {
      throw new ServiceError('unavailable', 'image_response_invalid', '图像服务返回了无法解析的响应。')
    }
  }

  async #fetchImageBytes(rawUrl: string, apiEndpoint: URL): Promise<Buffer> {
    let url: URL
    try { url = new URL(rawUrl) } catch { throw new ServiceError('invalid', 'image_url_invalid', '图像服务返回了无效的图片地址。') }
    // The response URL is attacker-influenced: only https, or same origin as
    // the configured endpoint (a private gateway legitimately serves http).
    const sameOrigin = url.protocol === apiEndpoint.protocol && url.host === apiEndpoint.host
    if (url.protocol !== 'https:' && !(sameOrigin && url.protocol === 'http:')) {
      throw new ServiceError('invalid', 'image_url_insecure', '图像服务返回的图片地址不是 HTTPS，且与服务商不同源，已拒绝下载。')
    }
    let response: Response
    try {
      response = await this.#fetch(url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { accept: 'image/*' },
        redirect: 'error',
      })
    } catch {
      throw new ServiceError('unavailable', 'image_fetch_failed', '无法从图像服务下载生成的图片。')
    }
    if (!response.ok) throw new ServiceError('unavailable', 'image_fetch_failed', `下载生成图片失败（HTTP ${response.status}）。`, response.status)
    return await readCappedBytes(response)
  }
}

function endpointFor(baseUrl: string): URL {
  let url: URL
  try { url = new URL(baseUrl.trim()) } catch { throw new ServiceError('invalid', 'image_base_url_invalid', '服务商地址格式不正确，无法定位图像接口。') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ServiceError('invalid', 'image_base_url_invalid', '服务商地址必须使用 http 或 https。')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/images/generations`
  return url
}

function finish(bytes: Buffer, revisedPrompt?: string): ImageGenerationResult {
  if (bytes.length === 0) throw new ServiceError('unavailable', 'image_response_empty', '图像服务返回了空文件。')
  const mimeType = sniffImageMime(bytes)
  if (mimeType === undefined) throw new ServiceError('unavailable', 'image_signature_unknown', '图像服务返回的内容不是可识别的图片（PNG/JPEG/WebP）。')
  return { bytes, mimeType, ...(revisedPrompt === undefined ? {} : { revisedPrompt }) }
}

export function sniffImageMime(bytes: Buffer): GeneratedImageMimeType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

async function readCappedText(response: Response): Promise<string> {
  return (await readCappedBytes(response)).toString('utf8')
}

async function readCappedBytes(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > MAX_IMAGE_BODY_BYTES) {
      await reader.cancel()
      throw new ServiceError('too-large', 'image_too_large', '图像响应超过大小上限，已停止读取。')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
