import { randomUUID } from 'node:crypto'

import type { JsonObject, ModelApiKind, ModelProviderKind } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { Router } from '../http/router.js'
import { HttpError } from '../http/errors.js'
import { nullableString, readJson, requiredEnum, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import { type ModelCredentialService } from '../services/model-credential-service.js'
import type { ModelCatalogService } from '../services/model-catalog-service.js'
import { assertModelBaseUrl, ModelUrlPolicyError } from '../services/model-url-policy.js'
import { ServiceError } from '../services/service-error.js'
import type { ModelProviderCatalogService } from '../services/model-provider-catalog.js'
import type { ModelProviderBalanceService } from '../services/model-provider-balance.js'
import type { ModelCapabilityProbeService } from '../services/model-capability-probe.js'

const PROVIDER_KINDS = ['deepseek', 'openai-compatible-local', 'openai-compatible-remote'] as const
const API_KINDS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const
const MAX_IMPORT_BATCH = 50

export interface ModelHubRoutesDependencies {
  store: SqliteStore
  credentials: ModelCredentialService
  modelCatalog: ModelCatalogService
  providerCatalog: ModelProviderCatalogService
  balance: ModelProviderBalanceService
  probe: ModelCapabilityProbeService
}

export function registerModelHubRoutes(router: Router, dependencies: ModelHubRoutesDependencies): void {
  const { store, credentials, modelCatalog, providerCatalog, balance, probe } = dependencies

  const resolveProviderKey = (providerId: string, credentialEnvName: string | undefined): string | undefined =>
    credentials.resolve(providerId)
    ?? (credentialEnvName !== undefined && credentialEnvName.length > 0 ? process.env[credentialEnvName] : undefined)

  router.get(/^\/api\/model-provider-catalog$/, async ({ response }) => {
    writeJson(response, 200, await providerCatalog.state())
  })

  router.post(/^\/api\/model-provider-catalog\/refresh$/, async ({ response }) => {
    writeJson(response, 200, await providerCatalog.state(true))
  })

  router.get(/^\/api\/workspaces\/([^/]+)\/model-providers$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    const { catalog } = await providerCatalog.state()
    const items = store.listModelProviders(workspaceId).map((provider) => {
      const profiles = store.listProviderProfiles(provider.id)
      const entry = catalog.providers.find((candidate) => candidate.id === provider.catalogRef)
      return {
        ...provider,
        modelCount: profiles.length,
        // A credential counts as configured when it is reachable right now:
        // the vault re-activates every stored entry's env var at start
        // (profile-keyed before the hub existed, provider-keyed after), and
        // owners may point at their own environment variable instead.
        credentialConfigured: provider.credentialEnvName !== undefined
          ? Boolean(process.env[provider.credentialEnvName]) || credentials.has(provider.id)
          : credentials.has(provider.id) || provider.providerKind === 'openai-compatible-local',
        assignedCount: profiles.filter((profile) => store.listModelAssignments(workspaceId)
          .some((assignment) => assignment.modelProfileId === profile.id)).length,
        balanceSupported: balance.supports(entry?.balance),
        ...(entry === undefined ? {} : { signup: entry.signup, balanceKind: entry.balance }),
      }
    })
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-providers$/, async ({ request, response, params }) => {
    const workspaceId = params[0]!
    const body = await readJson(request)
    const id = body.id === undefined ? randomUUID() : requiredString(body, 'id')
    const providerKind = requiredEnum(body, 'providerKind', PROVIDER_KINDS) as ModelProviderKind
    const api = requiredEnum(body, 'api', API_KINDS) as ModelApiKind
    const name = requiredString(body, 'name')
    const baseUrl = requiredString(body, 'baseUrl')
    try {
      assertModelBaseUrl(baseUrl, providerKind)
    } catch (error) {
      if (error instanceof ModelUrlPolicyError) throw new HttpError(422, error.code, error.message)
      throw error
    }
    const catalogRef = body.catalogRef === undefined ? undefined : requiredString(body, 'catalogRef')
    const apiKey = body.apiKey === undefined ? undefined : requiredString(body, 'apiKey')
    const credentialEnvName = body.credentialEnvName === undefined ? undefined : nullableString(body.credentialEnvName)
    if (apiKey !== undefined && credentialEnvName !== undefined) {
      throw new HttpError(422, 'credential_source_conflict', '只能选择直接填写密钥或使用环境变量其中一种。')
    }
    const kind = catalogRef !== undefined ? 'builtin' : providerKind === 'openai-compatible-local' ? 'local' : 'custom'
    const provider = store.saveModelProvider({
      id,
      workspaceId,
      kind,
      ...(catalogRef === undefined ? {} : { catalogRef }),
      name,
      baseUrl,
      api,
      providerKind,
      ...(credentialEnvName === undefined ? {} : { credentialEnvName }),
    })
    if (apiKey !== undefined && apiKey.trim() !== '') {
      const envName = await credentials.set(provider.id, apiKey)
      const saved = store.saveModelProvider({ ...provider, credentialEnvName: envName })
      writeJson(response, 200, { provider: saved })
      return
    }
    if (body.clearCredential === true) {
      await credentials.delete(provider.id)
      store.saveModelProvider({ ...provider, credentialEnvName: null })
    }
    writeJson(response, 200, { provider: store.getModelProvider(provider.id) ?? provider })
  })

  router.delete(/^\/api\/workspaces\/([^/]+)\/model-providers\/([^/]+)$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    const providerId = params[1]!
    const result = store.deleteModelProvider(workspaceId, providerId)
    if (result.status === 'not-found') throw new HttpError(404, 'model_provider_not_found', '服务商不存在。')
    if (result.status === 'blocked') {
      throw new HttpError(409, 'model_provider_in_use', `该服务商仍有 ${result.assignedScopeIds.length} 处分配在使用，请先在角色或世界设置中改用其它模型。`)
    }
    await credentials.delete(providerId)
    writeJson(response, 200, { removed: true })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-providers\/([^/]+)\/test$/, async ({ response, params }) => {
    const provider = requireProvider(store, params[0]!, params[1]!)
    const key = resolveProviderKey(provider.id, provider.credentialEnvName)
    const items = await modelCatalog.discover({
      baseUrl: provider.baseUrl,
      providerKind: provider.providerKind,
      api: provider.api,
      ...(key === undefined ? {} : { apiKey: key }),
    })
    writeJson(response, 200, { items })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-providers\/([^/]+)\/import$/, async ({ request, response, params }) => {
    const provider = requireProvider(store, params[0]!, params[1]!)
    const body = await readJson(request)
    const models = Array.isArray(body.models) ? body.models : null
    if (models === null || models.length === 0 || models.length > MAX_IMPORT_BATCH) {
      throw new HttpError(422, 'import_selection_invalid', `请勾选 1-${MAX_IMPORT_BATCH} 个模型再导入。`)
    }
    const existing = store.listProviderProfiles(provider.id)
    let created = 0
    let updated = 0
    for (const item of models) {
      if (item === null || typeof item !== 'object') continue
      const value = item as Record<string, unknown>
      const modelId = typeof value.id === 'string' ? value.id.trim() : ''
      if (!modelId) continue
      const displayName = typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.trim() : modelId
      const contextLength = typeof value.contextLength === 'number' && Number.isInteger(value.contextLength) && value.contextLength >= 1_024 ? value.contextLength : undefined
      const inputTypes = Array.isArray(value.inputTypes)
        ? value.inputTypes.filter((item): item is string => item === 'text' || item === 'image' || item === 'video' || item === 'audio').slice(0, 4)
        : undefined
      const reasoning = typeof value.reasoning === 'boolean' ? value.reasoning : undefined
      const settings: JsonObject = {}
      if (contextLength !== undefined) settings.contextWindow = contextLength
      if (inputTypes !== undefined && inputTypes.length > 0) settings.inputTypes = inputTypes
      if (reasoning !== undefined) settings.reasoning = reasoning
      const prior = existing.find((profile) => profile.modelId === modelId)
      // The connection owns the key; a profile re-imported before the provider
      // captured one (migration backfilled the profile's own reference) must
      // keep working, so the prior reference is the fallback.
      const credentialEnvName = provider.credentialEnvName ?? prior?.credentialEnvName
      store.saveModelProfile({
        ...(prior === undefined ? {} : { id: prior.id }),
        workspaceId: provider.workspaceId,
        providerId: provider.id,
        origin: 'imported',
        displayName,
        providerKind: provider.providerKind,
        baseUrl: provider.baseUrl,
        modelId,
        api: provider.api,
        ...(credentialEnvName === undefined ? {} : { credentialEnvName }),
        settings,
      })
      if (prior === undefined) created += 1
      else updated += 1
    }
    writeJson(response, 200, { created, updated, profiles: store.listProviderProfiles(provider.id) })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-providers\/([^/]+)\/sync$/, async ({ response, params }) => {
    const provider = requireProvider(store, params[0]!, params[1]!)
    const key = resolveProviderKey(provider.id, provider.credentialEnvName)
    const items = await modelCatalog.discover({
      baseUrl: provider.baseUrl,
      providerKind: provider.providerKind,
      api: provider.api,
      ...(key === undefined ? {} : { apiKey: key }),
    })
    const stored = store.listProviderProfiles(provider.id)
    const storedIds = new Set(stored.map((profile) => profile.modelId))
    const discoveredIds = new Set(items.map((item) => item.id))
    const added = items.filter((item) => !storedIds.has(item.id))
    const removed = stored.filter((profile) => !discoveredIds.has(profile.modelId)).map((profile) => ({ id: profile.id, modelId: profile.modelId }))
    const changed = items
      .filter((item) => storedIds.has(item.id))
      .map((item) => {
        const profile = stored.find((candidate) => candidate.modelId === item.id)
        const currentContext = typeof profile?.settings.contextWindow === 'number' ? profile.settings.contextWindow : undefined
        if (item.contextLength === undefined || item.contextLength === currentContext) return undefined
        return { modelId: item.id, from: currentContext, to: item.contextLength, profileId: profile?.id }
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
    writeJson(response, 200, { added, removed, changed, unchanged: items.length - added.length })
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-providers\/([^/]+)\/balance$/, async ({ response, params }) => {
    const provider = requireProvider(store, params[0]!, params[1]!)
    const { catalog } = await providerCatalog.state()
    const entry = catalog.providers.find((candidate) => candidate.id === provider.catalogRef)
    if (entry?.balance === undefined) {
      throw new HttpError(422, 'balance_unsupported', '该服务商暂不支持余额查询。')
    }
    const result = await balance.fetchBalance(provider, entry.balance, resolveProviderKey(provider.id, provider.credentialEnvName))
    writeJson(response, 200, result)
  })

  router.post(/^\/api\/workspaces\/([^/]+)\/model-profiles\/([^/]+)\/probe$/, async ({ response, params }) => {
    const workspaceId = params[0]!
    const profile = store.getModelProfile(params[1]!)
    if (profile === undefined || profile.workspaceId !== workspaceId) {
      throw new HttpError(404, 'model_profile_not_found', '模型不存在。')
    }
    const provider = profile.providerId === undefined ? undefined : store.getModelProvider(profile.providerId)
    const apiKey = credentials.resolve(profile.id)
      ?? (profile.credentialEnvName !== undefined ? process.env[profile.credentialEnvName] : undefined)
      ?? (provider === undefined ? undefined : resolveProviderKey(provider.id, provider.credentialEnvName))
    const outcome = await probe.probe(profile.id, {
      baseUrl: profile.baseUrl,
      modelId: profile.modelId,
      api: profile.api,
      apiKey,
    })
    if (outcome.status === 'cooldown') {
      throw new HttpError(429, 'probe_cooldown', `探测过于频繁，请 ${Math.ceil(outcome.retryAfterMs / 1000)} 秒后重试。`)
    }
    if (outcome.status === 'unsupported-protocol') {
      throw new HttpError(422, 'probe_unsupported_protocol', '当前接口协议暂不支持能力探测。')
    }
    const saved = store.setModelProfileCapabilities(profile.id, outcome.capabilities)
    writeJson(response, 200, { capabilities: outcome.capabilities, probedAt: saved?.probedAt ?? new Date().toISOString() })
  })
}

function requireProvider(store: SqliteStore, workspaceId: string, providerId: string) {
  const provider = store.getModelProvider(providerId)
  if (provider === undefined || provider.workspaceId !== workspaceId) {
    throw new HttpError(404, 'model_provider_not_found', '服务商不存在。')
  }
  return provider
}
