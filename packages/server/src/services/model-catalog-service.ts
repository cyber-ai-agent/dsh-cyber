import type { ModelApiKind, ModelProviderKind } from '@dsh-cyber/contracts'

import type { ModelCredentialService } from './model-credential-service.js'
import {
  assertModelDiscoveryUrl,
  inferModelProviderKind,
  systemModelHostnameResolver,
  type ModelHostnameResolver,
  type ModelUrlPolicyError,
} from './model-url-policy.js'
import { ServiceError } from './service-error.js'

const DEFAULT_TIMEOUT_MS = 12_000
const MAX_CATALOG_BYTES = 2 * 1024 * 1024

export interface ModelCatalogDiscoveryInput {
  baseUrl: string
  providerKind?: ModelProviderKind
  api: ModelApiKind
  apiKey?: string
  credentialEnvName?: string
  profileId?: string
}

/**
 * What `/models` reports about a model. Besides the id: the context window
 * (#152) and, where the endpoint declares them, the input modalities and the
 * reasoning capability — the model pool shows exactly these and never guesses:
 * a gateway that reports nothing renders '—' rather than an invented badge.
 */
export interface DiscoveredModel {
  id: string
  displayName?: string
  contextLength?: number
  inputTypes?: string[]
  reasoning?: boolean
}

const INPUT_MODALITIES = new Set(['text', 'image', 'video', 'audio'])
export interface ModelCatalogServiceOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  resolveHostname?: ModelHostnameResolver
  resolvePublicHosts?: boolean
}

/**
 * Local inference servers rarely publish the context window through the
 * OpenAI-compatible /v1/models list, but most of them expose it on a native
 * endpoint: llama.cpp answers n_ctx from /props, and LM Studio reports a
 * per-model max_context_length on /api/v0/models. Probing these turns "the
 * profile claims 64000 while the server enforces 2048" from a runtime 400
 * into a pre-filled, correct form. Only private/loopback endpoints are
 * probed — remote providers get metadata through their own catalog fields.
 */
const PROBE_TIMEOUT_MS = 2_500
const MAX_PROBE_BYTES = 512 * 1024

export class ModelCatalogService {
  readonly #credentials: ModelCredentialService
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #resolveHostname: ModelHostnameResolver
  readonly #resolvePublicHosts: boolean

  constructor(credentials: ModelCredentialService, options: ModelCatalogServiceOptions = {}) {
    this.#credentials = credentials
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#resolveHostname = options.resolveHostname ?? systemModelHostnameResolver
    this.#resolvePublicHosts = options.resolvePublicHosts ?? true
  }

  async discover(input: ModelCatalogDiscoveryInput): Promise<DiscoveredModel[]> {
    const providerKind = input.providerKind ?? inferModelProviderKind(input.baseUrl)
    let endpoint: URL
    try {
      endpoint = await assertModelDiscoveryUrl(input.baseUrl, providerKind, {
        resolver: this.#resolveHostname,
        resolvePublicHosts: this.#resolvePublicHosts,
      })
    } catch (error) {
      if (isModelUrlPolicyError(error)) {
        throw new ServiceError('invalid', error.code, error.message)
      }
      throw error
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/models`
    endpoint.search = ''
    endpoint.hash = ''
    const apiKey = input.apiKey?.trim()
      || (input.profileId ? this.#credentials.resolve(input.profileId) : undefined)
      || (input.credentialEnvName ? process.env[input.credentialEnvName] : undefined)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
      if (input.api === 'anthropic-messages') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(endpoint, { method: 'GET', headers, signal: controller.signal, redirect: 'error' })
    } catch (error) {
      if (isAbortError(error)) {
        throw new ServiceError('unavailable', 'model_catalog_timeout', '模型服务响应超时，请检查地址或稍后重试。')
      }
      throw new ServiceError('unavailable', 'model_catalog_unreachable', '无法连接模型服务，请检查接口地址和网络。')
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) throw upstreamCatalogError(response.status)
    const models = parseModels(await readCatalogJson(response))
    if (models.length === 0) {
      throw new ServiceError('invalid', 'model_catalog_empty', '服务已连接，但没有返回可用模型。你仍可手动填写模型 ID。')
    }
    if (providerKind === 'openai-compatible-local' && models.some((model) => model.contextLength === undefined)) {
      await this.#probeLocalContext(models, endpoint, headers)
    }
    return models
  }

  /** Fill missing context windows from local server metadata; failures stay silent. */
  async #probeLocalContext(models: DiscoveredModel[], endpoint: URL, headers: Record<string, string>): Promise<void> {
    const missing = () => models.some((model) => model.contextLength === undefined)
    if (!missing()) return
    const origin = `${endpoint.protocol}//${endpoint.host}`
    // llama.cpp (and many thin OpenAI wrappers) expose one global n_ctx.
    for (const path of ['/props', '/general/get_run_options']) {
      const value = await readProbeNumber(this.#fetch, origin + path, headers, (payload) => {
        const record = isRecord(payload) ? payload : undefined
        if (!record) return undefined
        const direct = record.n_ctx
        const nested = isRecord(record.default_generation_settings) ? record.default_generation_settings.n_ctx : undefined
        return typeof direct === 'number' ? direct : typeof nested === 'number' ? nested : undefined
      })
      if (value !== undefined) {
        for (const model of models) if (model.contextLength === undefined) model.contextLength = value
        return
      }
    }
    if (!missing()) return
    // LM Studio reports a per-model context in its native catalog.
    const catalog = await readProbeJson(this.#fetch, origin + '/api/v0/models', headers)
    if (catalog === undefined || !isRecord(catalog) || !Array.isArray(catalog.data)) return
    for (const model of models) {
      if (model.contextLength !== undefined) continue
      const entry = catalog.data.find((item) => isRecord(item) && item.id === model.id)
      if (!isRecord(entry)) continue
      const loaded = isRecord(entry.loaded_config) ? entry.loaded_config.max_context_length : undefined
      const meta = isRecord(entry.meta) ? entry.meta.context_length : undefined
      const value = typeof loaded === 'number' ? loaded : typeof meta === 'number' ? meta : undefined
      if (value !== undefined && value > 0) model.contextLength = value
    }
  }
}

function isModelUrlPolicyError(error: unknown): error is ModelUrlPolicyError {
  return error !== null && typeof error === 'object' && error instanceof Error && error.name === 'ModelUrlPolicyError'
}

function upstreamCatalogError(status: number): ServiceError {
  if (status === 401 || status === 403) return new ServiceError('forbidden', 'model_credential_rejected', 'API 密钥无效或没有访问权限，请检查后重试。', status)
  if (status === 404) return new ServiceError('not-found', 'model_catalog_not_found', '该接口没有提供模型列表，请确认接口地址以 /v1 结尾，或手动填写模型 ID。', status)
  if (status === 429) return new ServiceError('rate-limited', 'model_catalog_rate_limited', '模型服务请求过于频繁，请稍后重试。', status)
  if (status >= 500) return new ServiceError('unavailable', 'model_catalog_upstream_error', '模型服务暂时不可用，请稍后重试。', status)
  return new ServiceError('invalid', 'model_catalog_rejected', `模型服务拒绝了模型列表请求（状态码 ${status}）。`, status)
}

async function readCatalogJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
    throw new ServiceError('invalid', 'model_catalog_too_large', '模型列表响应过大，已停止读取。')
  }
  if (response.body === null) throw new ServiceError('invalid', 'model_catalog_invalid', '模型服务返回了空响应。')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.byteLength
    if (bytes > MAX_CATALOG_BYTES) {
      await reader.cancel()
      throw new ServiceError('invalid', 'model_catalog_too_large', '模型列表响应过大，已停止读取。')
    }
    chunks.push(result.value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown
  } catch {
    throw new ServiceError('invalid', 'model_catalog_invalid', '模型服务返回的模型列表格式无法识别。')
  }
}

function parseModels(value: unknown): DiscoveredModel[] {
  if (!isRecord(value)) return []
  const candidates = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : []
  const discovered = new Map<string, DiscoveredModel>()
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const id = candidate.trim()
      if (!discovered.has(id)) discovered.set(id, { id })
      continue
    }
    if (!isRecord(candidate)) continue
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : typeof candidate.name === 'string' ? candidate.name.trim() : ''
    if (!id) continue
    const displayName = typeof candidate.display_name === 'string'
      ? candidate.display_name.trim()
      : typeof candidate.displayName === 'string' ? candidate.displayName.trim() : undefined
    const contextLength = positiveNumber(candidate.context_length)
      ?? positiveNumber(candidate.max_context_length)
      ?? positiveNumber(candidate.max_model_len)
      ?? positiveNumber(candidate.effective_context_length)
      ?? (isRecord(candidate.metadata) ? positiveNumber(candidate.metadata.context_length) : undefined)
      ?? (isRecord(candidate.architecture) ? positiveNumber(candidate.architecture.context_length) : undefined)
    const inputTypes = extractInputTypes(candidate)
    const reasoning = extractReasoning(candidate)
    const existing = discovered.get(id)
    discovered.set(id, {
      id,
      ...(displayName ? { displayName } : existing?.displayName ? { displayName: existing.displayName } : {}),
      ...(contextLength !== undefined ? { contextLength } : existing?.contextLength ? { contextLength: existing.contextLength } : {}),
      ...(inputTypes !== undefined ? { inputTypes } : existing?.inputTypes ? { inputTypes: existing.inputTypes } : {}),
      ...(reasoning !== undefined ? { reasoning } : existing?.reasoning !== undefined ? { reasoning: existing.reasoning } : {}),
    })
  }
  return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

// OpenAI-compatible catalogues report input modalities inconsistently:
// OpenRouter nests them under `architecture.input_modalities`, other gateways
// flatten them to `input_modalities` or a single `modality` string like
// "text+image->text". Keep only the four types the product renders and drop the
// output half. Nothing matched yields undefined, so the pool shows '—' rather
// than guessing text.
function extractInputTypes(candidate: Record<string, unknown>): string[] | undefined {
  const raw = Array.isArray(candidate.input_modalities)
    ? candidate.input_modalities
    : isRecord(candidate.architecture) && Array.isArray(candidate.architecture.input_modalities)
    ? candidate.architecture.input_modalities
    : typeof candidate.modality === 'string'
    ? (candidate.modality.split('->')[0] ?? '').split('+')
    : []
  const types = new Set<string>()
  for (const value of raw) {
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    if (INPUT_MODALITIES.has(normalized)) types.add(normalized)
  }
  return types.size > 0 ? [...types].sort() : undefined
}

// Reasoning is only claimed when the endpoint says so — a supported parameter
// named reasoning/thinking, or an explicit boolean — never inferred from the
// model name.
function extractReasoning(candidate: Record<string, unknown>): boolean | undefined {
  if (typeof candidate.reasoning === 'boolean') return candidate.reasoning
  if (isRecord(candidate.capabilities) && typeof candidate.capabilities.reasoning === 'boolean') return candidate.capabilities.reasoning
  const supported = Array.isArray(candidate.supported_parameters)
    ? candidate.supported_parameters
    : isRecord(candidate.architecture) && Array.isArray(candidate.architecture.supported_parameters)
    ? candidate.architecture.supported_parameters
    : []
  if (supported.some((value) => value === 'reasoning' || value === 'thinking')) return true
  if (supported.length > 0) return false
  return undefined
}

async function readProbeJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: { ...headers, Accept: 'application/json' }, signal: controller.signal, redirect: 'error' })
    if (!response.ok) return undefined
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) return undefined
    const text = await response.text()
    if (text.length > MAX_PROBE_BYTES) return undefined
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

async function readProbeNumber(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  pick: (payload: unknown) => number | undefined,
): Promise<number | undefined> {
  const value = positiveNumber(pick(await readProbeJson(fetchImpl, url, headers)))
  return value !== undefined && value >= 1024 ? value : undefined
}

function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError' }
