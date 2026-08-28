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

export interface DiscoveredModel { id: string; displayName?: string }
export interface ModelCatalogServiceOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  resolveHostname?: ModelHostnameResolver
  resolvePublicHosts?: boolean
}

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
    return models
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
    const existing = discovered.get(id)
    discovered.set(id, { id, ...(displayName ? { displayName } : existing?.displayName ? { displayName: existing.displayName } : {}) })
  }
  return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError' }
