import type { ModelApiKind, ModelCapabilities, ModelCapabilityVerdict } from '@dsh-cyber/contracts'

import { ServiceError } from './service-error.js'

/**
 * A dry-run capability probe.
 *
 * "Can chat" is not "can work": an agent run needs the model to actually
 * honour a forced tool call, and knowledge extraction needs it to honour
 * `response_format: json_object`. This asks each question with a single tiny
 * request — an explicitly-allowed fake tool or a one-object JSON demand — and
 * records only the verdict. Request and response bodies never leave here.
 */
const PROBE_TIMEOUT_MS = 30_000
const COOLDOWN_MS = 60_000

export type ProbeOutcome =
  | { status: 'probed'; capabilities: ModelCapabilities }
  | { status: 'cooldown'; retryAfterMs: number }
  | { status: 'unsupported-protocol' }

export interface ProbeTarget {
  baseUrl: string
  modelId: string
  api: ModelApiKind
  apiKey: string | undefined
}

export class ModelCapabilityProbeService {
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #cooldownMs: number
  readonly #now: () => number
  readonly #lastProbed = new Map<string, number>()

  constructor(options: { fetch?: typeof fetch; timeoutMs?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
    this.#cooldownMs = options.cooldownMs ?? COOLDOWN_MS
    this.#now = options.now ?? Date.now
  }

  async probe(profileId: string, target: ProbeTarget): Promise<ProbeOutcome> {
    // Only the OpenAI-compatible chat surface can answer these questions; the
    // Anthropic request shape would need its own probe and is left honest-unknown.
    if (target.api !== 'openai-completions') return { status: 'unsupported-protocol' }
    const last = this.#lastProbed.get(profileId)
    const now = this.#now()
    if (last !== undefined && now - last < this.#cooldownMs) {
      return { status: 'cooldown', retryAfterMs: this.#cooldownMs - (now - last) }
    }
    this.#lastProbed.set(profileId, now)
    const [tools, json] = await Promise.all([
      this.#probeTools(target),
      this.#probeJson(target),
    ])
    return { status: 'probed', capabilities: { tools, json } }
  }

  async #post(url: string, apiKey: string | undefined, body: Record<string, unknown>): Promise<{ response: Response; payload: Record<string, unknown> | undefined } | { error: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey === undefined || apiKey.trim() === '' ? {} : { Authorization: `Bearer ${apiKey.trim()}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      })
      let payload: Record<string, unknown> | undefined
      try {
        const value: unknown = await response.json()
        payload = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
      } catch {
        payload = undefined
      }
      return { response, payload }
    } catch {
      // A transport failure says nothing about the model — the caller must
      // record 'error', never a false 'unsupported'.
      return { error: 'transport' }
    } finally {
      clearTimeout(timer)
    }
  }

  async #probeTools(target: ProbeTarget): Promise<ModelCapabilityVerdict> {
    let url: URL
    try {
      url = new URL(`${target.baseUrl.replace(/\/+$/, '')}/chat/completions`)
    } catch {
      return 'error'
    }
    const outcome = await this.#post(url.toString(), target.apiKey, {
      model: target.modelId,
      messages: [{ role: 'user', content: 'Reply by calling the echo_probe tool exactly.' }],
      tools: [{
        type: 'function',
        function: { name: 'echo_probe', description: 'Echo a fixed token. No side effects.', parameters: { type: 'object', properties: {}, required: [] } },
      }],
      tool_choice: { type: 'function', function: { name: 'echo_probe' } },
      max_tokens: 16,
    })
    if ('error' in outcome) return 'error'
    if (outcome.response.ok) {
      const toolCall = findToolCall(outcome.payload)
      if (toolCall === true) return 'supported'
      if (toolCall === false) return 'unclear'
      return 'error'
    }
    if (isParameterRejection(outcome.response.status, outcome.payload)) return 'unsupported'
    if (outcome.response.status === 401 || outcome.response.status === 403) throw new ServiceError('forbidden', 'probe_credential_rejected', '能力探测失败：API 密钥无效。')
    return 'error'
  }

  async #probeJson(target: ProbeTarget): Promise<ModelCapabilityVerdict> {
    let url: URL
    try {
      url = new URL(`${target.baseUrl.replace(/\/+$/, '')}/chat/completions`)
    } catch {
      return 'error'
    }
    const outcome = await this.#post(url.toString(), target.apiKey, {
      model: target.modelId,
      messages: [{ role: 'user', content: 'Return only the JSON object {"ok":true}.' }],
      response_format: { type: 'json_object' },
      max_tokens: 16,
    })
    if ('error' in outcome) return 'error'
    if (outcome.response.ok) {
      const text = firstMessageText(outcome.payload)
      if (text === undefined) return 'unclear'
      try {
        const parsed: unknown = JSON.parse(text)
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? 'supported' : 'unclear'
      } catch {
        return 'unclear'
      }
    }
    if (isParameterRejection(outcome.response.status, outcome.payload)) return 'unsupported'
    if (outcome.response.status === 401 || outcome.response.status === 403) throw new ServiceError('forbidden', 'probe_credential_rejected', '能力探测失败：API 密钥无效。')
    return 'error'
  }
}

function findToolCall(payload: Record<string, unknown> | undefined): boolean | undefined {
  if (payload === undefined) return undefined
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const message = (first as Record<string, unknown>).message
  if (message === null || typeof message !== 'object') return undefined
  const calls = (message as Record<string, unknown>).tool_calls
  return Array.isArray(calls) && calls.length > 0
}

function firstMessageText(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const first = choices[0]
  if (first === null || typeof first !== 'object') return undefined
  const message = (first as Record<string, unknown>).message
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : undefined
}

/**
 * A rejection that names the probe's own parameters is evidence the endpoint
 * does not implement them. Any other 4xx (a bad model id, a rate limit) says
 * nothing about capability.
 */
function isParameterRejection(status: number, payload: Record<string, unknown> | undefined): boolean {
  if (status < 400 || status >= 500 || status === 429) return false
  const text = JSON.stringify(payload ?? {}).toLowerCase()
  return /tools?|tool_choice|function_call|response_format|json_object|structured/.test(text)
}
