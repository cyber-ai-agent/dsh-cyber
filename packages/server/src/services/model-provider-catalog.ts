import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

import type {
  ModelApiKind,
  ModelProviderCatalog,
  ModelProviderCatalogEntry,
  ModelProviderCatalogSource,
  ModelProviderCatalogState,
  ModelProviderKind,
} from '@dsh-cyber/contracts'

import { BUNDLED_MODEL_PROVIDER_CATALOG } from './builtin-model-providers.js'

const MAX_CATALOG_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const API_KINDS = new Set<ModelApiKind>(['openai-completions', 'openai-responses', 'anthropic-messages'])
const PROVIDER_KINDS = new Set<ModelProviderKind>(['deepseek', 'openai-compatible-local', 'openai-compatible-remote'])

export class ModelProviderCatalogError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ModelProviderCatalogError'
    this.code = code
  }
}

export interface ModelProviderCatalogServiceOptions {
  stateRoot: string
  remoteUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  ttlMs?: number
  now?: () => number
}

/**
 * The built-in provider catalog with a three-level fallback:
 * remote (when configured and reachable) → the last good copy cached under
 * the state root → the snapshot bundled in this build. The file is untrusted
 * input: every entry passes the strict parser below before it reaches anyone,
 * and a rejected document never replaces a cached good one.
 */
export class ModelProviderCatalogService {
  readonly #stateRoot: string
  readonly #remoteUrl: string | undefined
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #ttlMs: number
  readonly #now: () => number
  #lastCheckedAt = 0
  #cached: { catalog: ModelProviderCatalog; source: ModelProviderCatalogSource } | undefined

  constructor(options: ModelProviderCatalogServiceOptions) {
    this.#stateRoot = options.stateRoot
    this.#remoteUrl = options.remoteUrl?.trim() || undefined
    this.#fetch = options.fetch ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.#now = options.now ?? Date.now
  }

  get cachePath(): string {
    return join(this.#stateRoot, 'model-hub', 'providers.json')
  }

  async state(forceRefresh = false): Promise<ModelProviderCatalogState> {
    const now = this.#now()
    if (!forceRefresh && this.#cached !== undefined && now - this.#lastCheckedAt < this.#ttlMs) {
      return { catalog: this.#cached.catalog, source: this.#cached.source, checkedAt: new Date(this.#lastCheckedAt).toISOString() }
    }
    let notice: string | undefined
    if (this.#remoteUrl !== undefined) {
      const outcome = await this.#fetchRemote()
      if (typeof outcome === 'object') {
        this.#set({ catalog: outcome, source: 'remote' }, now)
        await this.#writeCache(outcome)
        return this.#state(now)
      }
      if (outcome === 'error') notice = '无法获取远程服务商目录，已使用本地缓存。'
      // outcome === 'unchanged': fall through to the cache with a fresh clock.
    }
    try {
      const cached = await this.#readCache()
      if (cached !== undefined) {
        this.#set({ catalog: cached, source: 'cache' }, now)
        return { ...this.#state(now), ...(notice === undefined ? {} : { notice }) }
      }
    } catch {
      // A broken cache file is just an absent one.
    }
    this.#set({ catalog: BUNDLED_MODEL_PROVIDER_CATALOG, source: 'bundled' }, now)
    return { ...this.#state(now), ...(notice === undefined ? {} : { notice }) }
  }

  #set(value: { catalog: ModelProviderCatalog; source: ModelProviderCatalogSource }, now: number): void {
    this.#cached = value
    this.#lastCheckedAt = now
  }

  #state(now: number): ModelProviderCatalogState {
    const cached = this.#cached
    if (cached === undefined) throw new ModelProviderCatalogError('catalog_unavailable', '服务商目录尚不可用。')
    return { catalog: cached.catalog, source: cached.source, checkedAt: new Date(now).toISOString() }
  }

  async #fetchRemote(): Promise<ModelProviderCatalog | 'unchanged' | 'error'> {
    try {
      const url = new URL(this.#remoteUrl as string)
      if (url.protocol !== 'https:') return 'error'
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
      try {
        const response = await this.#fetch(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } })
        if (!response.ok) return 'error'
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_CATALOG_BYTES) return 'error'
        const text = await response.text()
        if (text.length > MAX_CATALOG_BYTES) return 'error'
        // Malformed documents never replace the last good copy — strict parse
        // first, and a parse throw lands in the 'error' branch below.
        const parsed = parseModelProviderCatalog(JSON.parse(text) as unknown)
        if (this.#cached !== undefined && this.#cached.catalog.version === parsed.version) return 'unchanged'
        return parsed
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return 'error'
    }
  }

  async #readCache(): Promise<ModelProviderCatalog | undefined> {
    try {
      const raw = await readFile(this.cachePath, 'utf8')
      return parseModelProviderCatalog(JSON.parse(raw) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return undefined
    }
  }

  async #writeCache(catalog: ModelProviderCatalog): Promise<void> {
    const serialized = JSON.stringify(catalog, null, 2)
    const directory = dirname(this.cachePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(this.cachePath, serialized, { mode: 0o600 })
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function trimmed(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined
}

function httpsUrl(value: unknown): string | undefined {
  const text = trimmed(value, 500)
  if (text === undefined) return undefined
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && url.hostname ? text : undefined
  } catch {
    return undefined
  }
}

function httpBaseUrl(value: unknown): string | undefined {
  const text = trimmed(value, 500)
  if (text === undefined) return undefined
  try {
    const url = new URL(text)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? text : undefined
  } catch {
    return undefined
  }
}

/** Strict, total rejection: any malformed entry or field rejects the whole document. */
export function parseModelProviderCatalog(value: unknown): ModelProviderCatalog {
  const document = record(value)
  if (document === undefined || document.schemaVersion !== 1) {
    throw new ModelProviderCatalogError('catalog_schema_invalid', '服务商目录格式不正确。')
  }
  const version = trimmed(document.version, 64)
  const providers = Array.isArray(document.providers) && document.providers.length <= 200 ? document.providers : null
  if (version === undefined || providers === null) {
    throw new ModelProviderCatalogError('catalog_schema_invalid', '服务商目录格式不正确。')
  }
  const ids = new Set<string>()
  const entries: ModelProviderCatalogEntry[] = []
  for (const item of providers) {
    const entry = record(item)
    if (entry === undefined) throw new ModelProviderCatalogError('catalog_entry_invalid', '服务商目录包含非对象条目。')
    const id = trimmed(entry.id, 64)
    const name = trimmed(entry.name, 80)
    const description = trimmed(entry.description, 300)
    const baseUrl = httpBaseUrl(entry.baseUrl)
    const apiRaw = entry.api
    const providerKindRaw = entry.providerKind
    const signup = record(entry.signup)
    const signupText = signup === undefined ? undefined : trimmed(signup.text, 300)
    const signupUrl = signup === undefined ? undefined : httpsUrl(signup.url)
    const credentialMode = entry.credentialMode
    const api = typeof apiRaw === 'string' && API_KINDS.has(apiRaw as ModelApiKind) ? apiRaw as ModelApiKind : undefined
    const providerKind = typeof providerKindRaw === 'string' && PROVIDER_KINDS.has(providerKindRaw as ModelProviderKind) ? providerKindRaw as ModelProviderKind : undefined
    if (
      id === undefined || ids.has(id)
      || name === undefined || description === undefined || baseUrl === undefined
      || api === undefined || providerKind === undefined
      || signupText === undefined || signupUrl === undefined
      || (credentialMode !== 'api-key' && credentialMode !== 'environment' && credentialMode !== 'none')
    ) {
      throw new ModelProviderCatalogError('catalog_entry_invalid', `服务商目录条目 ${String(entry.id ?? '未知')} 不合法。`)
    }
    ids.add(id)
    const popular = Array.isArray(entry.popularModels)
      ? entry.popularModels.filter((model): model is string => typeof model === 'string' && model.trim().length > 0 && model.length <= 120).slice(0, 50)
      : []
    const defaults = record(entry.defaults)
    const contextWindow = typeof defaults?.contextWindow === 'number' && Number.isInteger(defaults.contextWindow) && defaults.contextWindow >= 1024 ? defaults.contextWindow : undefined
    const maxTokens = typeof defaults?.maxTokens === 'number' && Number.isInteger(defaults.maxTokens) && defaults.maxTokens >= 1 ? defaults.maxTokens : undefined
    const webSearchBaseUrl = httpsUrl(defaults?.webSearchBaseUrl)
    const badge = trimmed(entry.badge, 20)
    const modelPlaceholder = trimmed(entry.modelPlaceholder, 120)
    const balance = entry.balance === 'deepseek' || entry.balance === 'openrouter' || entry.balance === 'moonshot' || entry.balance === 'siliconflow'
      ? entry.balance
      : undefined
    entries.push({
      id,
      name,
      description,
      baseUrl,
      api,
      providerKind,
      credentialMode: credentialMode as 'api-key' | 'environment' | 'none',
      signup: { text: signupText, url: signupUrl },
      popularModels: popular,
      ...(badge === undefined ? {} : { badge }),
      ...(modelPlaceholder === undefined ? {} : { modelPlaceholder }),
      ...(defaults === undefined ? {} : {
        defaults: {
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(webSearchBaseUrl === undefined ? {} : { webSearchBaseUrl }),
        },
      }),
      ...(balance === undefined ? {} : { balance }),
    })
  }
  return { schemaVersion: 1, version, providers: entries }
}

export function catalogContentHash(catalog: ModelProviderCatalog): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 16)
}
