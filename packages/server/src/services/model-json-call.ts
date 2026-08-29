import type { ModelApiKind, ModelProfile } from '@dsh-cyber/contracts'

import type { ModelCredentialService } from './model-credential-service.js'
import { assertModelDiscoveryUrl, type ModelHostnameResolver, systemModelHostnameResolver } from './model-url-policy.js'
import { ServiceError } from './service-error.js'

/**
 * One JSON answer from one model profile.
 *
 * Every provider shape difference — endpoint suffix, auth header, where the
 * text sits in the response — lives here, so a caller that needs a model to
 * classify or plan something writes a prompt and a parser and nothing else.
 *
 * Deliberately not an agent: no Employee, WorkSession, WorkTurn, AgentRun or
 * DSH worker is constructed. This is for host-side decisions that happen
 * before, or instead of, a character speaking.
 */

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024

export interface ModelJsonCallOptions {
  credentials: ModelCredentialService
  fetch?: typeof fetch
  resolveHostname?: ModelHostnameResolver
  timeoutMs?: number
  maxOutputTokens?: number
  /**
   * `native` asks OpenAI-compatible chat endpoints for JSON mode explicitly.
   * Some compatible gateways implement ordinary chat but reject
   * `response_format`; callers that already enforce JSON in their system prompt
   * can use `prompt-only` without weakening response parsing on the host.
   */
  jsonResponseMode?: 'native' | 'prompt-only'
}

export interface ModelJsonPrompt {
  system: string
  /**
   * The user half of the prompt.
   *
   * Callers should pass a JSON envelope rather than raw text, and say in
   * `system` that its contents are data. Anything reaching a planner or
   * classifier came from somewhere that may want to steer it.
   */
  user: string
}

export class ModelJsonCall {
  readonly #credentials: ModelCredentialService
  readonly #fetch: typeof fetch
  readonly #resolver: ModelHostnameResolver
  readonly #timeoutMs: number
  readonly #maxOutputTokens: number
  readonly #jsonResponseMode: 'native' | 'prompt-only'

  constructor(options: ModelJsonCallOptions) {
    this.#credentials = options.credentials
    this.#fetch = options.fetch ?? fetch
    this.#resolver = options.resolveHostname ?? systemModelHostnameResolver
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#maxOutputTokens = options.maxOutputTokens ?? 1_024
    this.#jsonResponseMode = options.jsonResponseMode ?? 'native'
  }

  /** Returns the model's raw text, which the caller parses. */
  async text(profile: ModelProfile, prompt: ModelJsonPrompt): Promise<string> {
    const url = await assertModelDiscoveryUrl(profile.baseUrl, profile.providerKind, { resolver: this.#resolver })
    const suffix = profile.api === 'openai-responses' ? 'responses' : profile.api === 'anthropic-messages' ? 'messages' : 'chat/completions'
    const normalized = url.pathname.replace(/\/+$/, '')
    url.pathname = normalized.endsWith(`/${suffix}`) ? normalized : `${normalized}/${suffix}`
    url.search = ''
    url.hash = ''

    const secret = this.#credentials.resolve(profile.id)
      ?? (profile.credentialEnvName === undefined ? undefined : process.env[profile.credentialEnvName])
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
    if (secret !== undefined && secret.trim() !== '') {
      headers.Authorization = `Bearer ${secret}`
      if (profile.api === 'anthropic-messages') {
        headers['x-api-key'] = secret
        headers['anthropic-version'] = '2023-06-01'
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(profile, prompt, this.#maxOutputTokens, this.#jsonResponseMode)),
        signal: controller.signal,
        // The base URL was checked against the SSRF policy; a followed
        // redirect would not be, and fetch re-sends Authorization and
        // x-api-key with it. A model endpoint has no legitimate reason to
        // bounce a completion.
        redirect: 'manual',
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServiceError('unavailable', 'model_call_timeout', '模型响应超时。')
      }
      throw new ServiceError('unavailable', 'model_call_unreachable', '无法连接模型服务。')
    } finally {
      clearTimeout(timeout)
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new ServiceError('unavailable', 'model_call_redirected', '模型接口发生了重定向，已拒绝以避免凭证外泄。', response.status)
    }
    if (!response.ok) {
      throw new ServiceError('unavailable', 'model_call_upstream_error', '模型服务返回了错误。', response.status)
    }
    return extractText(profile.api, await readBoundedJson(response))
  }
}

function requestBody(
  profile: ModelProfile,
  prompt: ModelJsonPrompt,
  maxOutputTokens: number,
  jsonResponseMode: 'native' | 'prompt-only',
): Record<string, unknown> {
  if (profile.api === 'anthropic-messages') {
    return {
      model: profile.modelId,
      max_tokens: maxOutputTokens,
      temperature: 0,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }
  }
  if (profile.api === 'openai-responses') {
    return {
      model: profile.modelId,
      temperature: 0,
      max_output_tokens: maxOutputTokens,
      instructions: prompt.system,
      input: prompt.user,
    }
  }
  return {
    model: profile.modelId,
    temperature: 0,
    max_tokens: maxOutputTokens,
    ...(jsonResponseMode === 'native' ? { response_format: { type: 'json_object' } } : {}),
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ServiceError('too-large', 'model_call_response_too_large', '模型响应过大。')
  }
  if (response.body === null) throw new ServiceError('unavailable', 'model_call_response_empty', '模型返回了空响应。')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new ServiceError('too-large', 'model_call_response_too_large', '模型响应过大。')
    }
    chunks.push(Buffer.from(result.value))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ServiceError('unavailable', 'model_call_response_invalid', '模型返回了无法识别的响应。')
  }
}

function extractText(api: ModelApiKind, value: unknown): string {
  const payload = object(value)
  const text = api === 'anthropic-messages'
    ? anthropicText(payload)
    : api === 'openai-responses' ? responsesText(payload) : completionsText(payload)
  if (text.trim() === '') throw new ServiceError('unavailable', 'model_call_response_invalid', '模型没有返回内容。')
  return text
}

function anthropicText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.flatMap((item) => {
    const part = objectOrUndefined(item)
    return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  }).join('')
}

function responsesText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text
  if (!Array.isArray(payload.output)) return ''
  return payload.output.flatMap((item) => {
    const output = objectOrUndefined(item)
    if (!Array.isArray(output?.content)) return []
    return output.content.flatMap((part) => {
      const content = objectOrUndefined(part)
      return (content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string' ? [content.text] : []
    })
  }).join('')
}

function completionsText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const message = objectOrUndefined(objectOrUndefined(choices[0])?.message)
  return typeof message?.content === 'string' ? message.content : ''
}

/**
 * Reads the one JSON object out of a model's answer.
 *
 * Models fence JSON in markdown and add a sentence before it even when told
 * not to, so the first balanced `{...}` is taken rather than the whole string.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // Try the next shape.
    }
  }
  throw new ServiceError('unavailable', 'model_call_response_invalid', '模型没有返回可解析的 JSON。')
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
